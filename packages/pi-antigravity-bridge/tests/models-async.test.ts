import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../src/process-tree.js", () => ({
	trackSpawnedIdentity: (child: unknown) => child,
	terminateProcessTree: async () => undefined,
}));

import { loadModelCatalogRaw, MODELS_CACHE_TTL_MS } from "../src/models.js";

interface FakeChild {
	proc: EventEmitter & { stdout: EventEmitter };
	stdout: EventEmitter;
}

const pending: FakeChild[] = [];

function useDeferredSpawn(): void {
	spawnMock.mockImplementation(() => {
		const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
		const proc = Object.assign(new EventEmitter(), { stdout }) as EventEmitter & { stdout: EventEmitter };
		pending.push({ proc, stdout });
		return proc;
	});
}

function finishChild(child: FakeChild, raw: string): void {
	child.stdout.emit("data", raw);
	child.proc.emit("close", 0);
}

function tempCachePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-models-async-")), "models-cache.json");
}

beforeEach(() => {
	spawnMock.mockReset();
	pending.length = 0;
	useDeferredSpawn();
});

test("models: concurrent cold loads share one discovery and atomic cache write", async () => {
	const cachePath = tempCachePath();
	const first = loadModelCatalogRaw("fake-agy", cachePath);
	const second = loadModelCatalogRaw("fake-agy", cachePath);
	await vi.waitFor(() => assert.equal(spawnMock.mock.calls.length, 1));
	assert.equal(pending.length, 1);
	finishChild(pending[0], "COLD");
	assert.deepEqual(await Promise.all([first, second]), ["COLD", "COLD"]);
	assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).raw, "COLD");
	assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), ["models-cache.json"], "no temp file remains");
});

test("models: concurrent stale loads share one background refresh", async () => {
	const cachePath = tempCachePath();
	fs.writeFileSync(cachePath, JSON.stringify({ raw: "OLD", savedAt: Date.now() - MODELS_CACHE_TTL_MS - 1 }));
	const [first, second] = await Promise.all([
		loadModelCatalogRaw("fake-agy", cachePath),
		loadModelCatalogRaw("fake-agy", cachePath),
	]);
	assert.deepEqual([first, second], ["OLD", "OLD"]);
	await vi.waitFor(() => assert.equal(spawnMock.mock.calls.length, 1));
	finishChild(pending[0], "FRESH");
	await vi.waitFor(() => {
		assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).raw, "FRESH");
	});
	assert.equal(spawnMock.mock.calls.length, 1);
});
