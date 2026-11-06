import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { basename } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	PROCESS_KILL_TIMEOUT_MS,
	terminateProcessTree,
	trackSpawnedIdentity,
	verifyExitedChildIdentity,
} from "../src/process-tree.js";

const children = new Set<ChildProcess>();

function dummy(script: string): ChildProcess {
	const child = spawn(process.execPath, ["-e", script], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	children.add(child);
	return child;
}

afterEach(() => {
	for (const child of children) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		try {
			child.kill("SIGKILL");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
		}
	}
	children.clear();
});

describe("owned process-tree termination", () => {
	test("a running Windows root uses exact-PID taskkill /T /F without an exited-identity query", async () => {
		const child = trackSpawnedIdentity(dummy("setInterval(() => {}, 1000)"), process.execPath);
		const exited = once(child, "exit");
		let identityQueries = 0;
		let taskkillArgs: string[] = [];
		await terminateProcessTree(child, {
			platform: "win32",
			execIdentityQuery: async () => {
				identityQueries += 1;
				return "";
			},
			execTreeKill: async (file, args, timeoutMs) => {
				assert.equal(file, "taskkill.exe");
				assert.equal(timeoutMs, PROCESS_KILL_TIMEOUT_MS);
				taskkillArgs = args;
				child.kill("SIGKILL"); // only the dummy spawned by this test
				return "";
			},
		});
		await exited;
		assert.deepEqual(taskkillArgs, ["/pid", String(child.pid), "/T", "/F"]);
		assert.equal(identityQueries, 0);
		assert.equal(child.stdin?.destroyed, true);
		assert.equal(child.stdout?.destroyed, true);
		assert.equal(child.stderr?.destroyed, true);
	});

	test("a matching exited image and creation time permit after-exit taskkill", async () => {
		const spawnedAtMs = Date.now();
		const child = trackSpawnedIdentity(dummy("process.exit(0)"), process.execPath, spawnedAtMs);
		await once(child, "exit");
		let taskkillCalls = 0;
		await terminateProcessTree(child, {
			platform: "win32",
			execIdentityQuery: async () => JSON.stringify({
				Name: basename(process.execPath),
				CreationDate: new Date(spawnedAtMs).toISOString(),
			}),
			execTreeKill: async (_file, args) => {
				taskkillCalls += 1;
				assert.equal(args[1], String(child.pid));
				return "";
			},
		});
		assert.equal(taskkillCalls, 1);
		assert.equal(child.stdout?.destroyed, true);
	});

	test("bare agy identity matches CIM agy.exe after root exit", async () => {
		const spawnedAtMs = Date.now();
		const child = trackSpawnedIdentity(dummy("process.exit(0)"), "agy", spawnedAtMs);
		await once(child, "exit");
		const identityQuery = async () => JSON.stringify({
			Name: "agy.exe",
			CreationDate: new Date(spawnedAtMs).toISOString(),
		});
		assert.equal(await verifyExitedChildIdentity(child, identityQuery), true);
		let taskkillCalls = 0;
		await terminateProcessTree(child, {
			platform: "win32",
			execIdentityQuery: identityQuery,
			execTreeKill: async () => {
				taskkillCalls += 1;
				return "";
			},
		});
		assert.equal(taskkillCalls, 1);
	});

	test("wrong image, stale creation time, malformed output, and missing tracking all skip taskkill", async () => {
		const spawnedAtMs = Date.now();
		const child = trackSpawnedIdentity(dummy("process.exit(0)"), process.execPath, spawnedAtMs);
		await once(child, "exit");
		const identities = [
			JSON.stringify({ Name: "not-the-dummy.exe", CreationDate: new Date(spawnedAtMs).toISOString() }),
			JSON.stringify({ Name: basename(process.execPath), CreationDate: new Date(0).toISOString() }),
			"not json",
		];
		let taskkillCalls = 0;
		for (const identity of identities) {
			await terminateProcessTree(child, {
				platform: "win32",
				execIdentityQuery: async () => identity,
				execTreeKill: async () => {
					taskkillCalls += 1;
					return "";
				},
			});
		}
		const untracked = dummy("process.exit(0)");
		await once(untracked, "exit");
		await terminateProcessTree(untracked, {
			platform: "win32",
			execIdentityQuery: async () => {
				throw new Error("an untracked PID must not even be queried");
			},
			execTreeKill: async () => {
				taskkillCalls += 1;
				return "";
			},
		});
		assert.equal(taskkillCalls, 0);
		assert.equal(child.stdin?.destroyed, true);
		assert.equal(child.stdout?.destroyed, true);
		assert.equal(child.stderr?.destroyed, true);
	});

	test("valid exited identity plus taskkill failure still settles owned stdio", async () => {
		const spawnedAtMs = Date.now();
		const child = trackSpawnedIdentity(dummy("process.exit(0)"), process.execPath, spawnedAtMs);
		await once(child, "exit");
		assert.equal(await verifyExitedChildIdentity(child, async () => JSON.stringify({
			Name: basename(process.execPath),
			CreationDate: new Date(spawnedAtMs + 5_000).toISOString(),
		})), true);
		await terminateProcessTree(child, {
			platform: "win32",
			execIdentityQuery: async () => JSON.stringify({
				Name: basename(process.execPath),
				CreationDate: new Date(spawnedAtMs).toISOString(),
			}),
			execTreeKill: async () => {
				throw new Error("injected taskkill failure");
			},
		});
		assert.equal(child.stdin?.destroyed, true);
		assert.equal(child.stdout?.destroyed, true);
		assert.equal(child.stderr?.destroyed, true);
	});

	test("POSIX process-group SIGTERM/SIGKILL behavior is preserved with injected signaling", async () => {
		const child = dummy("setInterval(() => {}, 1000)");
		const exited = once(child, "exit");
		const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		await terminateProcessTree(child, {
			platform: "linux",
			posixGroup: true,
			killProcess: (pid, signal) => {
				signals.push({ pid, signal });
				if (signal === "SIGTERM") child.kill("SIGKILL");
			},
		});
		await exited;
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.deepEqual(signals, [
			{ pid: -child.pid!, signal: "SIGTERM" },
			{ pid: -child.pid!, signal: "SIGKILL" },
		]);
		assert.equal(child.stdout?.destroyed, true);
	});

	test("POSIX group signals continue after root exit while descendants may retain the PGID", async () => {
		const child = dummy("process.exit(0)");
		await once(child, "exit");
		const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		await terminateProcessTree(child, {
			platform: "linux",
			posixGroup: true,
			killProcess: (pid, signal) => {
				signals.push({ pid, signal });
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.deepEqual(signals, [
			{ pid: -child.pid!, signal: "SIGTERM" },
			{ pid: -child.pid!, signal: "SIGKILL" },
		]);
		assert.equal(child.stdout?.destroyed, true);
	});

	test("POSIX group teardown ignores ESRCH for both signals", async () => {
		const child = dummy("process.exit(0)");
		await once(child, "exit");
		const errors: unknown[] = [];
		await terminateProcessTree(child, {
			platform: "linux",
			posixGroup: true,
			killProcess: () => {
				throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
			},
			onError: (err) => errors.push(err),
		});
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.deepEqual(errors, []);
	});
});
