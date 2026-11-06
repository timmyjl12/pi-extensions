// Capability-gated MCP server: exposes pi's tools to agy over Streamable HTTP.
//
// agy reads .agents/mcp_config.json from its --add-dir directories (verified),
// NOT from cwd. So we write our config into a bridge-controlled dir and the
// provider passes that dir as an EXTRA --add-dir. AskAntigravity omits it, so
// its agy starts plain. The user's global agy config is never touched.
//
// Hardening:
//   - The whole request handler is wrapped so a client error (ECONNRESET on a
//     killed-mid-call agy) can never crash the pi process.
//   - Per-process config dir (agy-mcp-<pid>): concurrent pi sessions each own
//     their file; no shared-file race, no cross-session routing.
//   - Shared-secret header: agy sends it from the config; a browser cannot set a
//     custom header on a simple cross-origin POST, so this blocks CSRF against
//     the loopback server. Combined with 127.0.0.1 binding.
//   - Request body size cap.
//
// The bridge routes calls through the provider's toolUse round-trip; it
// needs no privileged pi API.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	LATEST_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { GATED_AGY_TOOL_SET } from "./approval-hook.js";

/** Tools we do NOT expose to agy: it would just error (the provider is already
 *  antigravity, so the tool's own guard refuses; advertising it is noise). */
const SKIP_CIRCULAR = new Set(["AskAntigravity"]);

const BRIDGE_MCP_KEY = "pi-antigravity-bridge";
/** Shared-secret header every bridge request must carry. Exported: the ACP
 *  engine's mcpServers registration needs the same header name (the stream
 *  engine gets it via .agents/mcp_config.json; ACP gets it via headers[]). */
export const TOKEN_HEADER = "x-bridge-token";
const MAX_BODY_BYTES = 1_000_000;

// --- approval gate (docs/TODO.md 2.5) ---------------------------------------

/** stdin JSON of a PreToolUse hook, forwarded verbatim by the bundled poll
 *  script. Only toolCall is load-bearing here. */
export interface ApprovalPayload {
	toolCall: { name: string; args: Record<string, unknown> };
	stepIdx?: number;
	conversationId?: string;
	[key: string]: unknown;
}

/** Terminal decision for a parked approval (mirrors GateDecision from
 *  approval-gate.ts; deny MUST carry a reason - it is the only feedback
 *  agy's model gets, see V2). */
export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

export const APPROVAL_SETTLED_TTL_MS = 10 * 60 * 1000;

export interface SettledApprovalParkShape {
	terminal?: ApprovalDecision;
	settledAt?: number;
}

/** Deterministic settled-park TTL selection. Pending and recent entries stay;
 *  legacy timestamp-less terminal entries expire defensively. Delivery still
 *  deletes immediately in the route. Pure and exported for retention tests. */
export function expiredSettledApprovalTickets(
	entries: Iterable<readonly [string, SettledApprovalParkShape]>,
	nowMs: number,
): string[] {
	const expired: string[] = [];
	for (const [ticket, park] of entries) {
		if (
			park.terminal !== undefined &&
			(park.settledAt === undefined || nowMs - park.settledAt >= APPROVAL_SETTLED_TTL_MS)
		) {
			expired.push(ticket);
		}
	}
	return expired;
}

/** Provider-facing park controls: ticket verification for the shadow tools'
 *  marker calls, and completion when pi's tool result maps to a decision. */
export interface ApprovalParkApi {
	/** True while the ticket is still parked (unanswered, unexpired). */
	has(ticket: string): boolean;
	/** Settle a ticket. False when the id is unknown or already terminal. */
	resolve(ticket: string, decision: ApprovalDecision): boolean;
}

/** Human-decision latency budget for one parked approval. The staged hook
 *  timeout (approval-hook.stagedTimeoutSeconds) exceeds this with margin:
 *  a timed-out hook soft-passes (V3), so the park must time out FIRST and
 *  print a deny. Mirrors the G9 park budget. */
export const APPROVAL_PARK_TIMEOUT_MS = 480_000;

export interface McpServerHandle {
	port: number;
	/** Shared secret for TOKEN_HEADER. Callers that register the bridge with
	 *  an engine other than the stream-json discovery file need it. */
	token: string;
	/** Approval-gate park controls (docs/TODO.md 2.5). */
	approvals: ApprovalParkApi;
	close: () => Promise<void>;
}

export interface McpStartResult {
	ok: boolean;
	port?: number;
	handle?: McpServerHandle;
	reason?: string;
}

interface McpCloseable {
	close(): Promise<void>;
}

/** Close both per-request SDK resources. Server.close() delegates to the
 *  connected transport in the installed SDK; the explicit transport close is
 *  an idempotent backstop for partial connect/close failures. */
export async function closeMcpRequestResources(
	server: McpCloseable | undefined,
	transport: McpCloseable | undefined,
	log: (msg: string, data?: unknown) => void,
): Promise<void> {
	try {
		await server?.close();
	} catch (err) {
		log("request-server-close-error", { message: err instanceof Error ? err.message : String(err) });
	}
	try {
		await transport?.close();
	} catch (err) {
		log("request-transport-close-error", { message: err instanceof Error ? err.message : String(err) });
	}
	if (server || transport) log("request-resources-closed");
}

/** Provider-owned bridge surface. The provider builds the tool catalog
 *  (config-filtered: none|mcp|all + skills) and owns the toolUse round-trip:
 *  onToolCall parks the call, ends the pi assistant message with stopReason
 *  "toolUse" for the REAL pi tool, and resolves when pi hands back the
 *  toolResult on the next stream call. Fail-closed: the provider enforces a
 *  480s timeout and rejects when no agy turn is active. */
export interface McpBridgeDeps {
	listTools(): Array<{ name: string; description: string; inputSchema: object }> | Promise<Array<{ name: string; description: string; inputSchema: object }>>;
	onToolCall(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<import("./provider.js").BridgeCallResultShape>;
	/** Approval gate: called once per parked POST /approval, right after the
	 *  early-ack. The provider interrupts the pi-side view of the agy turn and
	 *  emits the shadow toolUse; the decision returns via approvals.resolve.
	 *  Optional: absent = every approval POST is denied directly (fail closed). */
	onApproval?(ticket: string, payload: ApprovalPayload): void;
}

/** Clamp an unsupported MCP-Protocol-Version header down to the SDK's LATEST.
 *
 *  agy negotiates a protocol version newer than this SDK ships (e.g. 2026-07-28
 *  vs LATEST 2025-11-25). initialize is exempt from the transport's header
 *  check, and the SDK's initialize handler already downgrades the body version
 *  itself, but EVERY follow-up (tools/list, tools/call,
 *  notifications/initialized) is validated against the header -> 400 +
 *  transport-error. This server is stateless (a fresh transport per request),
 *  so it cannot track the negotiated version across requests; rewriting any
 *  unsupported value to LATEST is the correct, spec-friendly downgrade. The
 *  Node->Web conversion (Hono getRequestListener) builds the Web Request from
 *  req.rawHeaders, NOT the parsed req.headers object, so the value must be
 *  rewritten in the raw array (kept in sync with req.headers for any other
 *  reader). */
function clampProtocolVersionHeader(req: http.IncomingMessage): void {
	const sent = req.headers["mcp-protocol-version"];
	if (typeof sent !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return;
	req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
	const raw = req.rawHeaders;
	for (let i = 0; i < raw.length - 1; i += 2) {
		if (raw[i].toLowerCase() === "mcp-protocol-version") raw[i + 1] = LATEST_PROTOCOL_VERSION;
	}
}

const BRIDGE_BASE = path.join(os.homedir(), ".pi", "agent", "antigravity-bridge");

/** Per-process config dir. Each pi session owns its own file, so concurrent
 *  sessions never race on or cross-route through one shared config. */
export function bridgeMcpConfigDir(): string {
	return path.join(BRIDGE_BASE, `agy-mcp-${process.pid}`);
}

function bridgeMcpConfigPath(): string {
	return path.join(bridgeMcpConfigDir(), ".agents", "mcp_config.json");
}

/** True if this process's bridge config exists (server is running). The
 *  provider uses this to decide whether to add the extra --add-dir. */
export function bridgeMcpConfigExists(): boolean {
	return fs.existsSync(bridgeMcpConfigPath());
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: alive but not ours to signal. ESRCH: no such process.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

const STALE_BRIDGE_SCAN_LIMIT = 256;
const STALE_BRIDGE_REMOVAL_LIMIT = 32;

/** Best-effort, bounded cleanup of stale per-pid dirs left by crashed sessions.
 *  opendir streams entries instead of materializing an unbounded directory. */
export async function sweepStaleBridgeDirs(opts: {
	baseDir?: string;
	isAlive?: (pid: number) => boolean;
	currentPid?: number;
	maxEntries?: number;
	maxRemovals?: number;
} = {}): Promise<string[]> {
	const baseDir = opts.baseDir ?? BRIDGE_BASE;
	const isAlive = opts.isAlive ?? isPidAlive;
	const currentPid = opts.currentPid ?? process.pid;
	const maxEntries = opts.maxEntries ?? STALE_BRIDGE_SCAN_LIMIT;
	const maxRemovals = opts.maxRemovals ?? STALE_BRIDGE_REMOVAL_LIMIT;
	const removed: string[] = [];
	let scanned = 0;
	try {
		for await (const entry of await fsp.opendir(baseDir)) {
			if (scanned >= maxEntries || removed.length >= maxRemovals) break;
			scanned++;
			const name = entry.name;
			if (!name.startsWith("agy-mcp-")) continue;
			const pid = Number(name.slice("agy-mcp-".length));
			if (!Number.isInteger(pid) || pid === currentPid || isAlive(pid)) continue;
			try {
				await fsp.rm(path.join(baseDir, name), { recursive: true, force: true });
				removed.push(name);
			} catch {
				/* best effort: the next startup retries */
			}
		}
	} catch {
		// Missing/unreadable base or an iteration failure: cleanup stays best effort.
	}
	return removed;
}

/** Write our .agents/mcp_config.json (serverUrl + shared-secret header) so a
 *  provider agy that adds this dir via --add-dir discovers us. Atomic write. */
async function writeBridgeMcpConfig(port: number, token: string): Promise<void> {
	const cfgPath = bridgeMcpConfigPath();
	const cfg = {
		mcpServers: {
			[BRIDGE_MCP_KEY]: {
				serverUrl: `http://127.0.0.1:${port}/mcp`,
				headers: { [TOKEN_HEADER]: token },
			},
		},
	};
	const tmp = `${cfgPath}.${process.pid}.tmp`;
	try {
		await fsp.mkdir(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
		await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
		await fsp.rename(tmp, cfgPath);
	} catch (err) {
		try {
			await fsp.unlink(tmp);
		} catch {
			/* preserve the write/rename error */
		}
		throw err;
	}
}

/** Normal shutdown can await removal; process exit uses the sync fallback below. */
async function removeBridgeMcpConfig(): Promise<void> {
	try {
		await fsp.rm(bridgeMcpConfigDir(), { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

function removeBridgeMcpConfigAtExit(): void {
	try {
		fs.rmSync(bridgeMcpConfigDir(), { recursive: true, force: true });
	} catch {
		/* process exit cannot await; next-launch sweep is the backstop */
	}
}

/** Options for {@link registerExitCleanup}. */
export interface ExitCleanupOptions {
	/** Signals to catch for abrupt-termination cleanup. Default SIGINT/SIGTERM. */
	signals?: NodeJS.Signals[];
	/** Override the host-ownership check (tests). Default excludes registry-owned
	 *  handlers and detects only real host listeners. */
	hasHostListener?: (sig: NodeJS.Signals) => boolean;
}

interface OwnedExitHandlers {
	onExit: () => void;
	signalHandlers: Map<NodeJS.Signals, () => void>;
}

type ExitCleanupRegistry = Map<string, OwnedExitHandlers>;

// Symbol.for is intentional: extension reloads and duplicate module instances
// must see one process-global registry, not stack independent process handlers.
const EXIT_CLEANUP_REGISTRY = Symbol.for("pi-antigravity-bridge.exit-cleanup-registry.v1");

function exitCleanupRegistry(): ExitCleanupRegistry {
	const holder = globalThis as unknown as Record<symbol, unknown>;
	const existing = holder[EXIT_CLEANUP_REGISTRY] as ExitCleanupRegistry | undefined;
	if (existing) return existing;
	const created: ExitCleanupRegistry = new Map();
	holder[EXIT_CLEANUP_REGISTRY] = created;
	return created;
}

function detachOwnedExitHandlers(record: OwnedExitHandlers): void {
	process.removeListener("exit", record.onExit);
	for (const [sig, handler] of record.signalHandlers) process.removeListener(sig, handler);
}

function isRegistryOwnedListener(listener: unknown): boolean {
	for (const record of exitCleanupRegistry().values()) {
		for (const handler of record.signalHandlers.values()) {
			if (handler === listener) return true;
		}
	}
	return false;
}

/** Register best-effort cleanup of this process's bridge config dir on process
 *  exit. Same-key re-registration detaches stale handlers WITHOUT running
 *  their cleanup, so an old module instance cannot delete the new config.
 *  Real host signal listeners always win; registry-owned handlers do not count
 *  as host listeners. Disposal is idempotent and cannot remove a replacement. */
export function registerExitCleanup(
	cleanup: () => void,
	opts: ExitCleanupOptions = {},
): () => void {
	const registry = exitCleanupRegistry();
	const key = bridgeMcpConfigDir();
	const stale = registry.get(key);
	if (stale) {
		detachOwnedExitHandlers(stale);
		registry.delete(key);
	}

	const signals = opts.signals ?? ["SIGINT", "SIGTERM"];
	const hasHostListener = opts.hasHostListener ?? ((sig: NodeJS.Signals) =>
		process.listeners(sig).some((listener) => !isRegistryOwnedListener(listener)));
	const record: OwnedExitHandlers = {
		onExit: (): void => cleanup(),
		signalHandlers: new Map(),
	};
	registry.set(key, record);
	process.once("exit", record.onExit);

	for (const sig of signals) {
		// The exit handler plus next-launch sweep cover host-owned signals.
		if (hasHostListener(sig)) continue;
		const handler = (): void => {
			cleanup();
			process.removeListener(sig, handler);
			record.signalHandlers.delete(sig);
			// Re-raise only when no REAL host listener appeared after install.
			// Other registry-owned handlers must not suppress default termination.
			if (!hasHostListener(sig)) process.kill(process.pid, sig);
		};
		record.signalHandlers.set(sig, handler);
		process.once(sig, handler);
	}

	let disposed = false;
	return (): void => {
		if (disposed) return;
		disposed = true;
		detachOwnedExitHandlers(record);
		if (registry.get(key) === record) registry.delete(key);
	};
}

export function createMcpCallHandler(
	deps: McpBridgeDeps,
	log: (msg: string, data?: unknown) => void,
) {
	return async (
		request: { params: { name: string; arguments?: unknown; _meta?: { progressToken?: unknown } } },
		signal?: AbortSignal,
	) => {
		const { name, arguments: args } = request.params;
		// Do not create a provider park/timer for work already cancelled.
		if (signal?.aborted) {
			log("call-tool-aborted", { name });
			return {
				content: [{ type: "text" as const, text: "Error: bridge call aborted before tool registration" }],
				isError: true,
			};
		}
		const meta = request.params._meta;
		if (meta && meta.progressToken !== undefined) {
			log("progress-token", { name, token: String(meta.progressToken) });
		}
		const callId = crypto.randomUUID();
		log("call-tool", { name, callId });
		try {
			const r = await deps.onToolCall(
				callId,
				name,
				(args && typeof args === "object" ? args : {}) as Record<string, unknown>,
				signal ?? new AbortController().signal,
			);
			const content =
				r.content && r.content.length > 0 ? r.content : [{ type: "text" as const, text: JSON.stringify(r) }];
			log("call-tool-ok", { name, callId });
			return { content, isError: r.isError ?? false };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log("call-tool-fail", { name, callId, msg });
			return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
		}
	};
}

export async function startMcpServer(
	deps: McpBridgeDeps,
	opts: {
		preferredPort?: number;
		log?: (s: string, d?: unknown) => void;
		/** Test override for the per-park timeout (deny, fail closed). */
		approvalTimeoutMs?: number;
	} = {},
): Promise<McpStartResult> {
	const log = opts.log ?? (() => {});
	const approvalTimeoutMs = opts.approvalTimeoutMs ?? APPROVAL_PARK_TIMEOUT_MS;

	const listHandler = async () => {
		const tools = await deps.listTools();
		log("list-tools", { count: tools.length });
		return { tools };
	};

	const callHandler = createMcpCallHandler(deps, log);

	const makeServer = (signal: AbortSignal) => {
		const s = new Server(
			{ name: "pi-antigravity-bridge", version: "1.1.0" },
			{ capabilities: { tools: {} } },
		);
		s.setRequestHandler(ListToolsRequestSchema, listHandler);
		s.setRequestHandler(CallToolRequestSchema, (request) => callHandler(request, signal));
		return s;
	};

	// Shared secret: agy sends it from the config headers. Browsers cannot set
	// custom headers on a simple cross-origin POST, so this blocks web CSRF
	// against the loopback server; local clients need the token too.
	const token = crypto.randomUUID();
	await sweepStaleBridgeDirs();

	// --- approval park (docs/TODO.md 2.5) ------------------------------------
	// Ticket -> parked approval. A settled ticket STAYS in the map until its
	// terminal decision is delivered to a poll, so the hook never 404s on the
	// answer; an unknown/expired ticket 404s and the hook fails closed.
	const parks = new Map<
		string,
		{ name: string; since: number; timer: NodeJS.Timeout; terminal?: ApprovalDecision; settledAt?: number }
	>();
	const sweepParks = (nowMs = Date.now()): void => {
		for (const ticket of expiredSettledApprovalTickets(parks.entries(), nowMs)) parks.delete(ticket);
	};
	const settlePark = (ticket: string, decision: ApprovalDecision): boolean => {
		const p = parks.get(ticket);
		if (!p || p.terminal) return false;
		p.terminal = decision;
		p.settledAt = Date.now();
		clearTimeout(p.timer);
		sweepParks(p.settledAt);
		return true;
	};
	const approvalsApi: ApprovalParkApi = {
		has: (ticket) => {
			const p = parks.get(ticket);
			return p !== undefined && p.terminal === undefined;
		},
		resolve: (ticket, decision) => settlePark(ticket, decision),
	};
	const decisionBody = (d: ApprovalDecision): string =>
		d.allow ? JSON.stringify({ decision: "allow" }) : JSON.stringify({ decision: "deny", reason: d.reason });
	const denyDirect = (res: http.ServerResponse, reason: string): void => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(decisionBody({ allow: false, reason }));
	};
	const tokenOk = (req: http.IncomingMessage): boolean => {
		const received = req.headers[TOKEN_HEADER];
		return (
			typeof received === "string" &&
			received.length === token.length &&
			crypto.timingSafeEqual(Buffer.from(received), Buffer.from(token))
		);
	};
	const readBody = async (req: http.IncomingMessage): Promise<string | null> => {
		let body = "";
		let bytes = 0;
		for await (const chunk of req) {
			body += chunk;
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) return null;
		}
		return body;
	};
	const approvalRoute = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		route: string,
	): Promise<void> => {
		if (!tokenOk(req)) {
			log("unauthorized", { url: req.url });
			res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
			return;
		}
		if (req.method === "POST" && route === "/approval") {
			const body = await readBody(req);
			if (body === null) {
				res.writeHead(413, { "content-type": "application/json", connection: "close" }).end('{"error":"payload too large"}');
				return;
			}
			let payload: ApprovalPayload;
			try {
				const parsed = JSON.parse(body) as ApprovalPayload;
				const name = parsed?.toolCall?.name;
				if (typeof name !== "string" || name.length === 0) throw new Error("no toolCall.name");
				if (!parsed.toolCall.args || typeof parsed.toolCall.args !== "object") {
					parsed.toolCall.args = {};
				}
				payload = parsed;
			} catch {
				res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid payload"}');
				return;
			}
			// Defense in depth: the hooks matcher should never let an ungated
			// tool through; deny directly instead of parking.
			if (!GATED_AGY_TOOL_SET.has(payload.toolCall.name)) {
				log("approval-ungated", { name: payload.toolCall.name });
				denyDirect(res, `tool ${payload.toolCall.name} is not in the approval matcher set`);
				return;
			}
			if (typeof deps.onApproval !== "function") {
				log("approval-unwired", { name: payload.toolCall.name });
				denyDirect(res, "approval gate is not wired; denying");
				return;
			}
			sweepParks();
			const ticket = crypto.randomUUID();
			const timer = setTimeout(() => {
				// Fail closed FIRST: the staged hook timeout is longer than this
				// park budget (V3: a hook outliving its timeout soft-passes, so the
				// park must answer the deny before the hook is killed).
				settlePark(ticket, { allow: false, reason: `approval gate timed out after ${Math.round(approvalTimeoutMs / 1000)}s` });
				log("approval-timeout", { ticket, name: payload.toolCall.name });
			}, approvalTimeoutMs);
			parks.set(ticket, { name: payload.toolCall.name, since: Date.now(), timer });
			log("approval-parked", { ticket, name: payload.toolCall.name });
			try {
				deps.onApproval(ticket, payload);
			} catch (e) {
				// A throwing provider must never hang the hook: settle deny now.
				log("approval-onapproval-fail", { ticket, msg: e instanceof Error ? e.message : String(e) });
				settlePark(ticket, { allow: false, reason: "approval gate internal error" });
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ticket }));
			return;
		}
		if (req.method === "GET" && route.startsWith("/approval/")) {
			const ticket = decodeURIComponent(route.slice("/approval/".length));
			const p = parks.get(ticket);
			if (!p) {
				// Unknown or already delivered: the hook fails closed on a 404.
				res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown ticket"}');
				return;
			}
			if (p.terminal) {
				parks.delete(ticket); // delivered; a repeat poll 404s (fail closed)
				log("approval-delivered", { ticket, name: p.name });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(decisionBody(p.terminal));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "pending" }));
			return;
		}
		res.writeHead(405).end();
	};

	return new Promise<McpStartResult>((resolve) => {
		const httpServer = http.createServer(async (req, res) => {
			// #1: a client-side stream error must never crash pi.
			req.on("error", (e) => {
				log("request-error", e instanceof Error ? e.message : String(e));
				try {
					if (!res.headersSent) res.writeHead(400).end();
					else res.end();
				} catch {
					/* socket already gone */
				}
			});
			try {
				if (req.url?.includes("/.well-known/")) {
					res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
					return;
				}
				const route = (req.url ?? "").split("?")[0];
				if (route === "/approval" || route.startsWith("/approval/")) {
					await approvalRoute(req, res, route);
					return;
				}
				if (req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				// #3: require the shared-secret header. Constant-time compare so a
				// timing oracle can't recover the token byte-by-byte.
				if (!tokenOk(req)) {
					log("unauthorized", { url: req.url });
					res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
					return;
				}
				// #4: cap request body size.
				let body = "";
				let bytes = 0;
				let tooLarge = false;
				for await (const chunk of req) {
					body += chunk;
					bytes += chunk.length;
					if (bytes > MAX_BODY_BYTES) {
						tooLarge = true;
						break;
					}
				}
				if (tooLarge) {
					// We bailed before draining the oversize body; close the connection
					// so the unread bytes can't desync the next request on this socket.
					res.writeHead(413, { "content-type": "application/json", connection: "close" }).end('{"error":"payload too large"}');
					return;
				}
				let parsed: { method?: string; params?: { protocolVersion?: string } };
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400).end("invalid json");
					return;
				}
				// Protocol version: agy negotiates a version newer than this SDK ships
				// (e.g. 2026-07-28 vs LATEST 2025-11-25). initialize is exempt from the
				// transport's header check and the SDK downgrades its body version
				// itself, but every follow-up (tools/list, tools/call,
				// notifications/initialized) is header-checked -> 400 + transport-error.
				// Clamp unsupported headers to LATEST. Stateless server (fresh transport
				// per request) can't track the negotiated version across requests.
				clampProtocolVersionHeader(req);
				// #6: cancel the invoked tool if agy disconnects mid-call (e.g. killed
				// by the runner timeout). req 'close' would fire on normal completion,
				// so we only abort on client abort / response-closed-before-finished.
				const ac = new AbortController();
				req.on("aborted", () => ac.abort());
				res.on("close", () => {
					if (!res.writableEnded) ac.abort();
				});
				let transport: StreamableHTTPServerTransport | undefined;
				let server: Server | undefined;
				try {
					// Stateless: a fresh transport+server per request, both closed below.
					transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
					transport.onerror = (e: Error) => log("transport-error", e.message);
					server = makeServer(ac.signal);
					await server.connect(transport);
					await transport.handleRequest(req, res, parsed as object);
				} catch (e) {
					log("handleRequest-error", e instanceof Error ? e.message : String(e));
					if (!res.headersSent) res.writeHead(500).end();
				} finally {
					await closeMcpRequestResources(server, transport, log);
				}
			} catch (e) {
				// Catch-all (e.g. errors during body read/clamp) so pi never crashes.
				log("request-handler-error", e instanceof Error ? e.message : String(e));
				try {
					if (!res.headersSent) res.writeHead(500).end();
				} catch {
					/* socket gone */
				}
			}
		});

		httpServer.on("error", (e) => {
			log("http-error", e instanceof Error ? e.message : String(e));
			resolve({ ok: false, reason: `http server error: ${e instanceof Error ? e.message : String(e)}` });
		});

		httpServer.listen(opts.preferredPort ?? 0, "127.0.0.1", () => {
			void (async () => {
				const addr = httpServer.address();
				const port = typeof addr === "object" && addr ? addr.port : 0;
				if (!port) {
					resolve({ ok: false, reason: "failed to bind" });
					return;
				}
				try {
					await writeBridgeMcpConfig(port, token);
					log("bridge-config-written", { port, path: bridgeMcpConfigPath() });
				} catch (e) {
					log("bridge-config-write-failed", e instanceof Error ? e.message : String(e));
				}
				// Clean up the config dir on abrupt termination (SIGINT/SIGTERM/crash)
				// where session_shutdown -> close() does not run. Disposed in close().
				const disposeExitCleanup = registerExitCleanup(removeBridgeMcpConfigAtExit);
				log("listening", { port });
				resolve({
					ok: true,
					port,
					handle: {
						port,
						token,
						approvals: approvalsApi,
						close: async () => {
							// Pending approvals fail closed on shutdown: the hook gets a
							// terminal deny instead of a 404 on its next poll.
							for (const [ticket, p] of [...parks]) {
								if (p.terminal) continue;
								settlePark(ticket, { allow: false, reason: "approval gate bridge shut down" });
							}
							await new Promise<void>((r) => httpServer.close(() => r()));
							await removeBridgeMcpConfig();
							disposeExitCleanup();
							log("bridge-config-removed", { port });
							log("closed", { port });
						},
					},
				});
			})().catch((e) => {
				log("startup-error", e instanceof Error ? e.message : String(e));
				resolve({ ok: false, reason: `bridge startup failed: ${e instanceof Error ? e.message : String(e)}` });
			});
		});
	});
}
