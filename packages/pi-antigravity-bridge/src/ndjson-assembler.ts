// Incremental NDJSON framing for chunk-oriented stdout streams.
//
// Only the trailing partial frame is retained. A completed frame is joined at
// most once (and not at all when it arrived contiguously), avoiding the
// quadratic append/split work caused by rescanning the whole buffer per chunk.

export class NdjsonFrameAssembler {
	#parts: string[] = [];
	#length = 0;
	readonly #maxFrameLength: number;

	constructor(maxFrameLength: number) {
		this.#maxFrameLength = maxFrameLength;
	}

	get bufferedLength(): number {
		return this.#length;
	}

	reset(): void {
		this.#parts = [];
		this.#length = 0;
	}

	/**
	 * Add one stdout chunk and emit each completed line in order. Returns the
	 * overflowing partial-frame length, or undefined when framing stayed within
	 * the cap. On overflow the assembler is reset and the rest of the chunk is
	 * ignored; callers must tear down the broken transport.
	 */
	push(chunk: string, onFrame: (frame: string) => void): number | undefined {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf("\n", start);
			const end = newline === -1 ? chunk.length : newline;
			if (end > start) {
				const part = chunk.slice(start, end);
				const nextLength = this.#length + part.length;
				if (nextLength > this.#maxFrameLength) {
					this.reset();
					return nextLength;
				}
				this.#parts.push(part);
				this.#length = nextLength;
			}

			if (newline === -1) return undefined;
			const frame =
				this.#parts.length === 0
					? ""
					: this.#parts.length === 1
						? this.#parts[0]
						: this.#parts.join("");
			this.reset();
			onFrame(frame);
			start = newline + 1;
		}
		return undefined;
	}
}
