// Stream Delta Sanitizer:
// Google Antigravity injects asynchronous background task notifications into
// the active LLM context formatted as:
//   The following is a <SYSTEM_MESSAGE> not actually sent by the user...
//   <SYSTEM_MESSAGE>
//   [Message] timestamp=... sender=... content=...
//   </SYSTEM_MESSAGE>
//
// Models (notably Gemini 3.8 Flash) frequently regurgitate or echo this preamble
// verbatim as an assistant text response before proceeding with tools or answer.
//
// StreamSanitizer buffers and strips these blocks statefully across streaming
// deltas so they never leak into the user's transcript.

export const START_MARKER = "The following is a <SYSTEM_MESSAGE>";
export const END_MARKER = "</SYSTEM_MESSAGE>";

/** Maximum UTF-16 code units retained for an unmatched system-message block.
 *
 * Below the cap, an unterminated block fails open on flush exactly as before.
 * Past the cap the sanitizer resets and throws SystemMessageOverflowError;
 * both turn engines catch it, fail the active turn, and tear down the transport.
 * Thus a malformed block can neither grow memory without bound nor be released
 * as one giant final delta. A block whose END_MARKER arrives in the same chunk
 * is still stripped normally, regardless of its size.
 */
export const MAX_UNMATCHED_SYSTEM_MESSAGE_CHARS = 1024 * 1024;

export class SystemMessageOverflowError extends Error {
	constructor(readonly unmatchedChars: number) {
		super(
			`unterminated SYSTEM_MESSAGE exceeded ${MAX_UNMATCHED_SYSTEM_MESSAGE_CHARS} characters ` +
				`(buffered ${unmatchedChars}); failing the turn`,
		);
		this.name = "SystemMessageOverflowError";
	}
}

export const SYSTEM_MESSAGE_RE =
	/(?:\r?\n)?The following is a <SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>(?:\r?\n)?/g;

/** Non-streaming sanitization for full text strings (result bodies, parked turns, transcripts). */
export function sanitizeSystemMessage(text: string): string {
	if (!text) return "";
	return text.replace(SYSTEM_MESSAGE_RE, "");
}

/** Stateful streaming sanitizer that inspects and suppresses <SYSTEM_MESSAGE> blocks across chunks. */
export class StreamSanitizer {
	#buffer = "";
	#suppressing = false;
	#suppressedAcc = "";
	#emittedAny = false;

	/**
	 * Feed an incoming chunk of streamed text.
	 * Returns the sanitized delta to emit downstream (empty string if suppressed or buffering).
	 */
	push(chunk: string): string {
		if (!chunk) return "";
		this.#buffer += chunk;
		let out = "";

		while (this.#buffer.length > 0) {
			if (!this.#suppressing) {
				const startIdx = this.#buffer.indexOf(START_MARKER);
				if (startIdx !== -1) {
					// There is a start marker in the buffer.
					if (startIdx > 0) {
						const before = this.#buffer.slice(0, startIdx);
						if (!this.#emittedAny && before.trim() === "") {
							// Discard leading padding before initial system message.
						} else {
							// Strip at most one trailing newline right before the block.
							const trimmedBefore = before.replace(/\r?\n$/, "");
							if (trimmedBefore.length > 0) {
								out += trimmedBefore;
								this.#emittedAny = true;
							}
						}
					}
					this.#buffer = this.#buffer.slice(startIdx + START_MARKER.length);
					this.#suppressing = true;
					this.#suppressedAcc = START_MARKER;
					continue;
				}

				// START_MARKER is not yet in the buffer.
				// Check if the tail of buffer matches a prefix of START_MARKER.
				const maxOverlap = Math.min(this.#buffer.length, START_MARKER.length - 1);
				let overlapLen = 0;
				for (let len = maxOverlap; len > 0; len--) {
					if (START_MARKER.startsWith(this.#buffer.slice(-len))) {
						overlapLen = len;
						break;
					}
				}

				if (overlapLen > 0) {
					const safeLen = this.#buffer.length - overlapLen;
					if (safeLen > 0) {
						out += this.#buffer.slice(0, safeLen);
						this.#emittedAny = true;
						this.#buffer = this.#buffer.slice(safeLen);
					}
					// Keep overlapLen in buffer to see if next chunk completes the marker.
					break;
				} else {
					out += this.#buffer;
					this.#emittedAny = true;
					this.#buffer = "";
					break;
				}
			} else {
				// Suppressing inside <SYSTEM_MESSAGE>...</SYSTEM_MESSAGE>
				const endIdx = this.#buffer.indexOf(END_MARKER);
				if (endIdx !== -1) {
					let afterEnd = endIdx + END_MARKER.length;
					if (!this.#emittedAny) {
						// Discard all leading newlines before the first real content.
						while (
							afterEnd < this.#buffer.length &&
							(this.#buffer[afterEnd] === "\r" || this.#buffer[afterEnd] === "\n")
						) {
							afterEnd++;
						}
					} else {
						// Consume trailing newlines after </SYSTEM_MESSAGE> to preserve paragraph spacing.
						if (this.#buffer.startsWith("\r\n\r\n", afterEnd)) {
							afterEnd += 4;
						} else if (this.#buffer.startsWith("\n\n", afterEnd)) {
							afterEnd += 2;
						} else if (this.#buffer.startsWith("\r\n", afterEnd)) {
							afterEnd += 2;
						} else if (this.#buffer.startsWith("\n", afterEnd)) {
							afterEnd += 1;
						}
					}
					this.#buffer = this.#buffer.slice(afterEnd);
					this.#suppressing = false;
					this.#suppressedAcc = "";
					continue;
				}

				// Bound only an UNMATCHED block. Complete blocks take the normal
				// stripping path above; below-cap unterminated blocks still fail
				// open on flush. Reset before throwing so the error path retains
				// neither a large suppressed accumulator nor a large flush delta.
				const unmatchedChars = this.#suppressedAcc.length + this.#buffer.length;
				if (unmatchedChars > MAX_UNMATCHED_SYSTEM_MESSAGE_CHARS) {
					this.reset();
					throw new SystemMessageOverflowError(unmatchedChars);
				}

				// END_MARKER not yet encountered. Check if tail matches prefix of END_MARKER.
				const maxOverlap = Math.min(this.#buffer.length, END_MARKER.length - 1);
				let overlapLen = 0;
				for (let len = maxOverlap; len > 0; len--) {
					if (END_MARKER.startsWith(this.#buffer.slice(-len))) {
						overlapLen = len;
						break;
					}
				}

				if (overlapLen > 0) {
					this.#suppressedAcc += this.#buffer.slice(0, -overlapLen);
					this.#buffer = this.#buffer.slice(-overlapLen);
				} else {
					this.#suppressedAcc += this.#buffer;
					this.#buffer = "";
				}
				break;
			}
		}

		return out;
	}

	/** Flush remaining buffered text when stream ends. */
	flush(): string {
		if (this.#suppressing) {
			const unclosed = this.#suppressedAcc + this.#buffer;
			this.#buffer = "";
			this.#suppressedAcc = "";
			this.#suppressing = false;
			if (unclosed.length > 0) {
				this.#emittedAny = true;
			}
			return unclosed;
		}
		const remaining = this.#buffer;
		this.#buffer = "";
		if (remaining.length > 0) {
			this.#emittedAny = true;
		}
		return remaining;
	}

	/** Peek at non-suppressed buffer contents without consuming them. */
	peek(): string {
		return this.#suppressing ? "" : this.#buffer;
	}

	/** Reset state. */
	reset(): void {
		this.#buffer = "";
		this.#suppressedAcc = "";
		this.#suppressing = false;
		this.#emittedAny = false;
	}
}
