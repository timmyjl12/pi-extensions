// Unit tests for SessionStore load-time narrowing (src/sessions.ts).
//
// Proves a corrupt or hand-edited sessions.json can't plant wrong-typed fields
// into the cache: malformed entries are dropped and bad lastStepIdx values fall
// back to -1. Written as raw JSON text (not JSON.stringify) so the 1e999 token
// survives as Infinity through JSON.parse.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { SessionStore, type AgySession } from "../src/sessions.js";

function tmpStorePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "agy-sessions-")),
    "sessions.json",
  );
}

test("SessionStore: missing file starts empty (no throw)", () => {
  const store = new SessionStore(tmpStorePath());
  assert.equal(store.size, 0);
  assert.equal(store.get("anything"), null);
});

test("SessionStore: load drops malformed entries, keeps valid ones", () => {
  const p = tmpStorePath();
  fs.writeFileSync(
    p,
    JSON.stringify({
      good: { conversationId: "abc-123", lastStepIdx: 5 },
      badId: { conversationId: 123, lastStepIdx: 2 }, // id not a string -> drop
      badIdx: { conversationId: "xyz", lastStepIdx: "no" }, // idx not a number -> keep, -1
      nonObj: "string-value", // not an object -> drop
      missing: { lastStepIdx: 3 }, // no conversationId -> drop
    }) + "\n",
  );
  const store = new SessionStore(p);
  assert.deepEqual(store.get("good"), {
    conversationId: "abc-123",
    lastStepIdx: 5,
    lastMessageCount: 0,
  });
  assert.equal(store.get("badId"), null);
  assert.deepEqual(store.get("badIdx"), {
    conversationId: "xyz",
    lastStepIdx: -1,
    lastMessageCount: 0,
  });
  assert.equal(store.get("nonObj"), null);
  assert.equal(store.get("missing"), null);
});

test("SessionStore: non-finite lastStepIdx (Infinity from 1e999) falls back to -1", () => {
  const p = tmpStorePath();
  // Raw text: 1e999 parses to Infinity, which Number.isFinite rejects.
  fs.writeFileSync(
    p,
    `{"huge": {"conversationId": "big", "lastStepIdx": 1e999}}\n`,
  );
  const store = new SessionStore(p);
  assert.deepEqual(store.get("huge"), {
    conversationId: "big",
    lastStepIdx: -1,
    lastMessageCount: 0,
  });
});

test("SessionStore: set/get round-trip in memory (incl. lastMessageCount watermark)", () => {
  const store = new SessionStore(tmpStorePath());
  store.set("k", {
    conversationId: "c-1",
    lastStepIdx: 9,
    lastMessageCount: 42,
  });
  assert.deepEqual(store.get("k"), {
    conversationId: "c-1",
    lastStepIdx: 9,
    lastMessageCount: 42,
  });
  assert.equal(store.size, 1);
});

test("SessionStore: top-level non-object file is treated as empty", () => {
  const p = tmpStorePath();
  fs.writeFileSync(p, `[1, 2, 3]`); // array, not an object
  const store = new SessionStore(p);
  assert.equal(store.size, 0);
});

test("SessionStore: delete drops only the target key, in memory and on disk", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("a", {
    conversationId: "conv-a",
    lastStepIdx: 1,
    lastMessageCount: 5,
  });
  store.set("b", {
    conversationId: "conv-b",
    lastStepIdx: 2,
    lastMessageCount: 7,
  });
  store.delete("a");
  assert.equal(store.get("a"), null);
  assert.equal(store.get("b")?.conversationId, "conv-b");
  assert.equal(store.size, 1);
  // persist() overlays dirty keys on the on-disk state; the deleted key must
  // not resurrect from it.
  await vi.waitFor(() => {
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.ok(!("a" in disk), "deleted key must not persist");
    assert.equal(disk.b?.conversationId, "conv-b");
  });
});

test("SessionStore: set after delete resurrects the key", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("k", {
    conversationId: "c-1",
    lastStepIdx: 0,
    lastMessageCount: 3,
  });
  store.delete("k");
  store.set("k", {
    conversationId: "c-2",
    lastStepIdx: -1,
    lastMessageCount: 0,
  });
  assert.deepEqual(store.get("k"), {
    conversationId: "c-2",
    lastStepIdx: -1,
    lastMessageCount: 0,
  });
  await vi.waitFor(() => {
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(disk.k?.conversationId, "c-2");
  });
});

test("SessionStore: a removed key stops being deleted once its persist lands (multi-process)", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("a", {
    conversationId: "conv-a",
    lastStepIdx: 0,
    lastMessageCount: 1,
  });
  store.delete("a");
  await vi.waitFor(() => {
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.ok(!("a" in disk), "delete must land first");
  });
  // Another process reclaims the key (the cwd-fallback key is shared across
  // pi processes in one directory). Our NEXT unrelated persist must honor
  // its write, not replay our stale deletion.
  fs.writeFileSync(
    p,
    JSON.stringify({
      a: {
        conversationId: "conv-other-process",
        lastStepIdx: 3,
        lastMessageCount: 9,
      },
    }) + "\n",
  );
  store.set("b", {
    conversationId: "conv-b",
    lastStepIdx: 0,
    lastMessageCount: 2,
  });
  await vi.waitFor(() => {
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(
      disk.a?.conversationId,
      "conv-other-process",
      "unrelated persist must not re-delete a reclaimed key",
    );
    assert.equal(disk.b?.conversationId, "conv-b");
  });
});

test("SessionStore: interleaved stores and updates never lose queued operations", async () => {
  const p = tmpStorePath();
  const first = new SessionStore(p);
  const second = new SessionStore(p);
  for (let i = 0; i < 24; i++) {
    first.set(`first-${i}`, {
      conversationId: `first-conv-${i}`,
      lastStepIdx: i,
    });
    second.set(`second-${i}`, {
      conversationId: `second-conv-${i}`,
      lastStepIdx: i,
    });
  }
  first.set("shared", { conversationId: "shared-old", lastStepIdx: 0 });
  second.set("shared", { conversationId: "shared-middle", lastStepIdx: 1 });
  first.set("shared", { conversationId: "shared-final", lastStepIdx: 2 });
  first.delete("first-0");
  second.set("after-delete", {
    conversationId: "after-delete",
    lastStepIdx: 0,
  });

  await vi.waitFor(() => {
    const disk = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
      string,
      AgySession
    >;
    assert.equal(Object.keys(disk).length, 49);
    assert.equal(disk.shared?.conversationId, "shared-final");
    assert.equal(disk["after-delete"]?.conversationId, "after-delete");
    assert.equal(disk["first-0"], undefined);
    assert.equal(disk["second-23"]?.conversationId, "second-conv-23");
  });
});

test("SessionStore: clear is an ordered operation, not a dirty-set reset", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("before-clear", { conversationId: "old", lastStepIdx: 1 });
  store.clear();
  store.set("after-clear", {
    conversationId: "new",
    lastStepIdx: 0,
    lastMessageCount: 0,
  });
  await vi.waitFor(() => {
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.deepEqual(disk, {
      "after-clear": {
        conversationId: "new",
        lastStepIdx: 0,
        lastMessageCount: 0,
      },
    });
  });
});

test("SessionStore: failed stale set does not roll back a newer cross-instance write", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  const writeSpy = vi
    .spyOn(fs.promises, "writeFile")
    .mockImplementationOnce(async () => {
      throw new Error("transient write failure");
    });
  try {
    store.set("shared", { conversationId: "old", lastStepIdx: 1 });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    fs.writeFileSync(
      p,
      JSON.stringify({ shared: { conversationId: "new", lastStepIdx: 2 } }) +
        "\n",
    );
    store.set("other", { conversationId: "other", lastStepIdx: 0 });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(2));
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(
      disk.shared?.conversationId,
      "new",
      "the newer binding must not be rolled back by the failed stale set",
    );
    assert.equal(
      disk.other?.conversationId,
      "other",
      "the newer operation must still persist",
    );
  } finally {
    writeSpy.mockRestore();
  }
});

test("SessionStore: failed delete completes when the previous value is unchanged", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("stale", { conversationId: "stale", lastStepIdx: 1 });
  await vi.waitFor(() => expect(fs.existsSync(p)).toBe(true));
  const writeSpy = vi
    .spyOn(fs.promises, "writeFile")
    .mockImplementationOnce(async () => {
      throw new Error("transient delete failure");
    });
  try {
    store.delete("stale");
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    store.set("other", { conversationId: "other", lastStepIdx: 0 });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(2));
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(
      disk.stale,
      undefined,
      "the stale binding must be removed after the transient failure",
    );
    assert.equal(disk.other?.conversationId, "other");
  } finally {
    writeSpy.mockRestore();
  }
});

test("SessionStore: failed delete does not re-delete a recreated binding", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("shared", { conversationId: "old", lastStepIdx: 1 });
  await vi.waitFor(() => expect(fs.existsSync(p)).toBe(true));
  const writeSpy = vi
    .spyOn(fs.promises, "writeFile")
    .mockImplementationOnce(async () => {
      throw new Error("transient delete failure");
    });
  try {
    store.delete("shared");
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    fs.writeFileSync(
      p,
      JSON.stringify({ shared: { conversationId: "new", lastStepIdx: 2 } }) +
        "\n",
    );
    store.set("other", { conversationId: "other", lastStepIdx: 0 });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(2));
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(
      disk.shared?.conversationId,
      "new",
      "the recreated binding must not be deleted by the stale operation",
    );
    assert.equal(disk.other?.conversationId, "other");
  } finally {
    writeSpy.mockRestore();
  }
});

test("SessionStore: failed clear removes pre-clear keys while preserving newer bindings", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("before-clear", { conversationId: "old", lastStepIdx: 1 });
  await vi.waitFor(() => expect(fs.existsSync(p)).toBe(true));
  const writeSpy = vi
    .spyOn(fs.promises, "writeFile")
    .mockImplementationOnce(async () => {
      throw new Error("transient clear failure");
    });
  try {
    store.clear();
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    fs.writeFileSync(
      p,
      JSON.stringify({
        external: { conversationId: "external", lastStepIdx: 1 },
      }) + "\n",
    );
    store.set("after-clear", { conversationId: "new", lastStepIdx: 0 });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(2));
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(
      disk["before-clear"],
      undefined,
      "the pre-clear binding must be removed",
    );
    assert.equal(
      disk["after-clear"]?.conversationId,
      "new",
      "the newer binding must be preserved",
    );
    assert.equal(
      disk.external?.conversationId,
      "external",
      "the external cross-instance binding must be preserved",
    );
  } finally {
    writeSpy.mockRestore();
  }
});

test("SessionStore: failed set does not resurrect a deleted binding", async () => {
  const p = tmpStorePath();
  const store = new SessionStore(p);
  store.set("shared", { conversationId: "old", lastStepIdx: 1 });
  await vi.waitFor(() => expect(fs.existsSync(p)).toBe(true));
  const writeSpy = vi
    .spyOn(fs.promises, "writeFile")
    .mockImplementationOnce(async () => {
      throw new Error("transient set failure");
    });
  try {
    store.set("shared", { conversationId: "new", lastStepIdx: 2 });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    fs.rmSync(p, { force: true });
    store.set("other", { conversationId: "other", lastStepIdx: 0 });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(2));
    const disk = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(
      disk.shared,
      undefined,
      "the deleted binding must not be resurrected by the stale set",
    );
    assert.equal(disk.other?.conversationId, "other");
  } finally {
    writeSpy.mockRestore();
  }
});
