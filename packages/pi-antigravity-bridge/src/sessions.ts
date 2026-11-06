// Persisted map: pi session key -> agy conversation id + last streamed step.
//
// agy holds its own conversation history in the DB keyed by conversation id.
// To resume a multi-turn pi conversation, we thread the same agy id across
// streamSimple calls and skip steps we already streamed last turn.
//
// The key is options.sessionId when pi provides it, else the cwd (single-
// conversation-per-process fallback). Stored at
// ~/.pi/agent/antigravity-bridge/sessions.json with atomic rename.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "antigravity-bridge",
  "sessions.json",
);

export interface AgySession {
  conversationId: string;
  lastStepIdx: number;
  /** pi context.messages length captured at the start of the last agy turn.
   *  Used by the provider to compute a delta digest of pi-side context agy
   *  was not spawned for (compaction summaries, other-provider turns). 0 on a
   *  fresh or pre-watermark session. Optional for backward compat with older
   *  persisted sessions that predate the watermark. */
  lastMessageCount?: number;
}

type StoreMap = Record<string, AgySession>;

/** Narrow untrusted parsed JSON into a clean StoreMap, validating each entry's
 *  shape instead of trusting the whole structure (the cast previously let a
 *  hand-edited or corrupt file plant wrong-typed fields into the cache).
 *  Drops any entry whose `conversationId` isn't a string; falls back to -1 when
 *  `lastStepIdx` is missing or not a finite number. Returns {} for non-object
 *  input. */
function narrowStoreMap(parsed: unknown): StoreMap {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const clean: StoreMap = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object") continue;
    const conversationId = (value as { conversationId?: unknown })
      .conversationId;
    if (typeof conversationId !== "string") continue;
    const idx = (value as { lastStepIdx?: unknown }).lastStepIdx;
    const mc = (value as { lastMessageCount?: unknown }).lastMessageCount;
    clean[key] = {
      conversationId,
      lastStepIdx: typeof idx === "number" && Number.isFinite(idx) ? idx : -1,
      lastMessageCount: typeof mc === "number" && Number.isFinite(mc) ? mc : 0,
    };
  }
  return clean;
}

type StoreOperation =
  | { type: "set"; key: string; session: AgySession; previous?: AgySession }
  | { type: "delete"; key: string; previous?: AgySession }
  | { type: "clear"; previousKeys: string[] };

function sameSessionValue(
  first: AgySession | undefined,
  second: AgySession,
): boolean {
  return (
    first?.conversationId === second.conversationId &&
    first.lastStepIdx === second.lastStepIdx &&
    (first.lastMessageCount ?? 0) === (second.lastMessageCount ?? 0)
  );
}

// One queue per file across stores AND extension reloads. Each operation is
// captured when queued, so a later set/delete/clear cannot be erased when an
// earlier async flush finishes. Cross-process writes still merge from a fresh
// disk snapshot immediately before every atomic rename.
const STORE_QUEUES_KEY = Symbol.for(
  "pi-antigravity-bridge.session-write-queues.v1",
);
const storeQueues: Map<string, Promise<void>> = ((
  globalThis as Record<symbol, unknown>
)[STORE_QUEUES_KEY] ??= new Map()) as Map<string, Promise<void>>;
let sessionTempCounter = 0;

/** Atomic-write JSON session store with fire-and-forget serialized persistence. */
export class SessionStore {
  private readonly path: string;
  private cache: StoreMap = {};
  private failed: StoreOperation[] = [];

  constructor(storePath: string = STORE_PATH) {
    this.path = storePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.path, "utf8");
      this.cache = narrowStoreMap(JSON.parse(raw));
    } catch {
      // missing or corrupt  -  start empty. The first set() will create it.
      this.cache = {};
    }
  }

  get(key: string): AgySession | null {
    const s = this.cache[key];
    if (!s || typeof s.conversationId !== "string") return null;
    return {
      conversationId: s.conversationId,
      lastStepIdx: s.lastStepIdx ?? -1,
      lastMessageCount: s.lastMessageCount ?? 0,
    };
  }

  /** Update one session and persist atomically (temp file + rename). The
   *  write is queued; callers don't need to await it. */
  set(key: string, session: AgySession): void {
    const previous = this.cache[key];
    const snapshot = { ...session };
    this.cache[key] = snapshot;
    this.enqueue({ type: "set", key, session: snapshot, previous });
  }

  /** Drop one session binding and persist the deletion. Used when the driver
   *  recreated the conversation under us: the record's watermark claims
   *  history the new conversation never saw, and its bound id keeps the
   *  sysPrompt gate closed. Dropping resets the watermark to 0 AND re-arms
   *  the gate on the next turn (issue #1). The write is queued. */
  delete(key: string): void {
    const previous = this.cache[key];
    delete this.cache[key];
    this.enqueue({ type: "delete", key, previous });
  }

  private enqueue(operation: StoreOperation): void {
    const key = path.resolve(this.path);
    const previous = storeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.flush(operation));
    // Keep the public API fire-and-forget. Failed operations stay pending and
    // are prepended to the next flush instead of being silently dropped.
    const settled = run.catch(() => undefined);
    storeQueues.set(key, settled);
    void settled.then(() => {
      if (storeQueues.get(key) === settled) storeQueues.delete(key);
    });
  }

  private async flush(operation: StoreOperation): Promise<void> {
    // Capture this operation at enqueue time. Do NOT drain later operations
    // into an earlier turn: another store's intervening write to the same key
    // must retain the real cross-instance order.
    const retryCount = this.failed.length;
    const operations = [...this.failed, operation];
    this.failed = [];
    try {
      let merged: StoreMap = {};
      if (operations[0]?.type !== "clear" || retryCount > 0) {
        try {
          const raw = await fs.promises.readFile(this.path, "utf8");
          merged = narrowStoreMap(JSON.parse(raw));
        } catch {
          /* missing or corrupt  -  start from empty */
        }
      }
      for (const [index, op] of operations.entries()) {
        const isRetry = index < retryCount;
        if (isRetry) {
          // A failed operation is only safe to retry when it cannot roll back
          // a newer value written by another instance. Otherwise the other
          // writer has already won and the stale operation is discarded.
          if (op.type === "set") {
            const current = merged[op.key];
            if (current === undefined) {
              // Do not resurrect a key another instance deleted after the
              // failed set. Only a previously absent key is safe to create.
              if (op.previous !== undefined) continue;
            } else if (!sameSessionValue(current, op.session)) {
              continue;
            }
          } else if (op.type === "delete") {
            // Only re-delete when the key is absent or still has the value that
            // was present when delete() was called. A different value means
            // another instance has already won and must not be rolled back.
            if (
              merged[op.key] !== undefined &&
              (!op.previous || !sameSessionValue(merged[op.key], op.previous))
            )
              continue;
          } else if (isRetry) {
            // A failed clear removes exactly the bindings that existed when
            // /agy clear was issued, preserving any newer bindings.
            for (const key of op.previousKeys) delete merged[key];
            continue;
          } else {
            merged = {};
          }
        }
        if (op.type === "set") merged[op.key] = op.session;
        else if (op.type === "delete") delete merged[op.key];
        else merged = {};
      }

      const tmp = `${this.path}.${process.pid}.${++sessionTempCounter}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
        await fs.promises.writeFile(
          tmp,
          JSON.stringify(merged, null, 2) + "\n",
          { mode: 0o600 },
        );
        await fs.promises.rename(tmp, this.path);
      } catch (err) {
        try {
          await fs.promises.unlink(tmp);
        } catch {
          /* preserve the write/rename error */
        }
        throw err;
      }
    } catch (err) {
      this.failed = [...operations, ...this.failed];
      throw err;
    }
  }

  /** Wipe all session bindings (forces fresh agy conversations on every
   *  active session). Used by the /agy clear command. */
  clear(): void {
    const previousKeys = Object.keys(this.cache);
    this.cache = {};
    this.enqueue({ type: "clear", previousKeys });
  }

  /** Count persisted session bindings (for status display). */
  get size(): number {
    return Object.keys(this.cache).length;
  }
}
