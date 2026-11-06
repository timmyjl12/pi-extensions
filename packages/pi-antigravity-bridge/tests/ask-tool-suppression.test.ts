// Regression: bridge suppression must span the WHOLE delegated `agy -p` run.
// The old 5s grace timer re-enabled the pi-bridge entries mid-run; agy watches
// mcp_config.json (ReloadMcpConfig) and reconnected to the live host bridge,
// producing fail-closed "no active antigravity turn" call-tool-fail toasts
// (observed live 2026-09-09: deny ~50s into a peer-review delegation). The
// release may fire only when the delegated process closes.
//
// Seam: registerAskAntigravityTool with AGY_BIN pointed at a fake binary that
// outlives the old 5s timer. mcp-registration is mocked (the real one rewrites
// the user's global ~/.gemini/config/mcp_config.json); the spies record WHEN
// acquire/release fire relative to process close.
//
// Run: npm test

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const suppressionEvents: Array<{ event: "acquire" | "release"; t: number }> =
  [];
let releaseError: Error | undefined;
let failSpawn = false;

vi.mock("../src/mcp-registration.js", () => ({
  acquireBridgeSuppression: async () => {
    suppressionEvents.push({ event: "acquire", t: Date.now() });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      suppressionEvents.push({ event: "release", t: Date.now() });
      if (releaseError) throw releaseError;
    };
  },
}));

import { registerAskAntigravityTool } from "../src/ask-tool.js";

// The fake agy must outlive the OLD 5s grace so an early timer release is
// observable as a release timestamp ~1s before process close.
const FAKE_AGY_SLEEP_MS = 6000;

function makeFakeAgyProcess(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  Object.defineProperty(child, "pid", { value: 424242 });
  if (failSpawn) {
    process.nextTick(() => child.emit("error", new Error("spawn ENOENT")));
    return child;
  }
  child.kill = vi.fn(() => {
    clearTimeout(exitTimer);
    stdout.destroy();
    stderr.destroy();
    stdin.destroy();
    child.emit("exit", 0);
    child.emit("close", 0);
    return true;
  });
  const exitTimer = setTimeout(() => {
    stdout.emit(
      "data",
      '{"event":"init","init":{"conversation_id":"conv-fake"}}\n',
    );
    stdout.emit(
      "data",
      '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"fake answer"}}\n',
    );
    stdout.emit(
      "data",
      '{"event":"result","result":{"status":"SUCCESS","response":"fake answer"}}\n',
    );
    child.emit("exit", 0);
    child.emit("close", 0);
  }, FAKE_AGY_SLEEP_MS);
  return child;
}

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // Only spawn is faked; execFile and all other process-tree helpers remain real.
  spawn: () => makeFakeAgyProcess(),
}));

test(
  "bridge suppression releases at process close, never on an early timer",
  { timeout: 20_000 },
  async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
    const bin = path.join(tempRoot, "agy");
    const prevBin = process.env.AGY_BIN;
    process.env.AGY_BIN = bin;
    try {
      const tools: Array<{
        execute: (
          id: string,
          params: Record<string, unknown>,
          signal?: unknown,
          onUpdate?: unknown,
          ctx?: Record<string, unknown>,
        ) => Promise<unknown>;
      }> = [];
      const fakePi = {
        registerTool: (tool: {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal?: unknown,
            onUpdate?: unknown,
            ctx?: Record<string, unknown>,
          ) => Promise<unknown>;
        }) => tools.push(tool),
        registerCommand: () => {},
        on: () => {},
        sendMessage: () => {},
      } as unknown as ExtensionAPI;
      await registerAskAntigravityTool(fakePi, []);
      expect(tools).toHaveLength(1);

      const start = Date.now();
      // Empty ctx: the executor's circular-delegation guard dereferences
      // ctx.model, so the context must exist even when bare.
      await tools[0].execute(
        "t1",
        { prompt: "noop", cwd: process.cwd(), timeoutMinutes: 1 },
        undefined,
        undefined,
        {},
      );
      const done = Date.now();

      // The fake agy really ran to completion (and outlived the old grace).
      expect(done - start).toBeGreaterThanOrEqual(FAKE_AGY_SLEEP_MS - 500);

      const acquires = suppressionEvents.filter((e) => e.event === "acquire");
      const releases = suppressionEvents.filter((e) => e.event === "release");
      expect(acquires).toHaveLength(1);
      expect(releases).toHaveLength(1);

      // Old bug: the timer released at ~5s while the run continued to ~6s.
      // The release must land with (or after) the process's sleep, not ~1s
      // ahead of completion.
      expect(releases[0].t).toBeGreaterThanOrEqual(
        start + FAKE_AGY_SLEEP_MS - 500,
      );
    } finally {
      if (prevBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevBin;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  "suppression releases when the spawn itself fails",
  { timeout: 20_000 },
  async () => {
    // AGY_BIN points at a path that does not exist: spawn emits "error",
    // the tool surfaces "failed to run agy", and the error path must still
    // fire exactly one release (no leak on the non-clean-exit route).
    const bin = path.join(
      os.tmpdir(),
      `agy-bin-missing-${process.pid}-${Date.now()}`,
    );
    fs.rmSync(bin, { force: true });
    const prevBin = process.env.AGY_BIN;
    process.env.AGY_BIN = bin;
    failSpawn = true;
    try {
      const tools: Array<{
        execute: (
          id: string,
          params: Record<string, unknown>,
          signal?: unknown,
          onUpdate?: unknown,
          ctx?: Record<string, unknown>,
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
      }> = [];
      const fakePi = {
        registerTool: (tool: {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal?: unknown,
            onUpdate?: unknown,
            ctx?: Record<string, unknown>,
          ) => Promise<{ content: Array<{ type: string; text: string }> }>;
        }) => tools.push(tool),
        registerCommand: () => {},
        on: () => {},
        sendMessage: () => {},
      } as unknown as ExtensionAPI;
      await registerAskAntigravityTool(fakePi, []);

      const before = suppressionEvents.length;
      const start = Date.now();
      const res = await tools[0].execute(
        "t2",
        { prompt: "noop", cwd: process.cwd(), timeoutMinutes: 1 },
        undefined,
        undefined,
        {},
      );
      const events = suppressionEvents.slice(before);

      // Failed fast (spawn error, not the watchdog) and said so.
      expect(Date.now() - start).toBeLessThan(5000);
      expect(JSON.stringify(res)).toContain("failed to run agy");
      expect(events.filter((e) => e.event === "acquire")).toHaveLength(1);
      expect(events.filter((e) => e.event === "release")).toHaveLength(1);
    } finally {
      failSpawn = false;
      if (prevBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevBin;
    }
  },
);

test(
  "a release failure does not mask a completed agy turn",
  { timeout: 20_000 },
  async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
    const bin = path.join(tempRoot, "agy");
    const prevBin = process.env.AGY_BIN;
    process.env.AGY_BIN = bin;
    releaseError = new Error("simulated release failure");
    try {
      const tools: Array<{
        execute: (
          id: string,
          params: Record<string, unknown>,
          signal?: unknown,
          onUpdate?: unknown,
          ctx?: Record<string, unknown>,
        ) => Promise<unknown>;
      }> = [];
      const fakePi = {
        registerTool: (tool: {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal?: unknown,
            onUpdate?: unknown,
            ctx?: Record<string, unknown>,
          ) => Promise<unknown>;
        }) => tools.push(tool),
        registerCommand: () => {},
        on: () => {},
        sendMessage: () => {},
      } as unknown as ExtensionAPI;
      await registerAskAntigravityTool(fakePi, []);

      const before = suppressionEvents.length;
      const res = await tools[0].execute(
        "t-release",
        { prompt: "noop", cwd: process.cwd(), timeoutMinutes: 1 },
        undefined,
        undefined,
        {},
      );
      expect(JSON.stringify(res)).not.toContain("failed to run agy");
      const events = suppressionEvents.slice(before);
      expect(events.filter((e) => e.event === "release")).toHaveLength(1);
    } finally {
      releaseError = undefined;
      if (prevBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevBin;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
