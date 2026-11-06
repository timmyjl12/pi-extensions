// Config tests: engine + bridgeTools knobs round-trip through load/save and
// unrelated saves never clobber them (the merge regression class).

import { test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadConfigAsync, saveConfig } from "../src/config.js";

function tmpConfig(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-cfg-")), "config.json");
}

/** Pin process.stdout.isTTY for the duration of run(): the TTY-aware turn-cap
 *  default must not depend on ambient stdio (CI, piped vitest, TTY shells). */
function stubTTY(value: boolean | undefined, run: () => void): void {
	const out = process.stdout as unknown as { isTTY?: boolean };
	const prev = out.isTTY;
	out.isTTY = value;
	try {
		run();
	} finally {
		if (prev === undefined) delete out.isTTY;
		else out.isTTY = prev;
	}
}

test("config: defaults select the full bridge surface", () => {
	const p = tmpConfig();
	try {
		const c = loadConfig(p);
		assert.equal(c.bridgeTools, "all");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: bridgeTools round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		for (const surface of ["all", "mcp", "none"] as const) {
			saveConfig({ bridgeTools: surface }, p);
			assert.equal(loadConfig(p).bridgeTools, surface);
		}
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: unrelated save does not clobber bridgeTools", () => {
	const p = tmpConfig();
	try {
		saveConfig({ bridgeTools: "none" }, p);
		saveConfig({ mode: "plan" }, p);
		const c = loadConfig(p);
		assert.equal(c.bridgeTools, "none");
		assert.equal(c.mode, "plan");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: invalid bridgeTools value falls back to the default surface", () => {
	const p = tmpConfig();
	try {
		saveConfig({ bridgeTools: "bogus" as never }, p);
		assert.equal(loadConfig(p).bridgeTools, "all");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: askTool defaults on and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).askTool, true);
		saveConfig({ askTool: false }, p);
		assert.equal(loadConfig(p).askTool, false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: digest defaults off and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).digest, false);
		saveConfig({ digest: true }, p);
		assert.equal(loadConfig(p).digest, true);
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).digest, true);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: systemPrompt defaults on and round-trips through load/save", () => {
	const p = tmpConfig();
	try {
		assert.equal(loadConfig(p).systemPrompt, true);
		saveConfig({ systemPrompt: false }, p);
		assert.equal(loadConfig(p).systemPrompt, false);
		saveConfig({ mode: "plan" }, p);
		assert.equal(loadConfig(p).systemPrompt, false);
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: AGY_SYSTEM_PROMPT env overrides the file in both directions", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_SYSTEM_PROMPT;
	try {
		saveConfig({ systemPrompt: true }, p);
		process.env.AGY_SYSTEM_PROMPT = "off";
		assert.equal(loadConfig(p).systemPrompt, false);
		saveConfig({ systemPrompt: false }, p);
		process.env.AGY_SYSTEM_PROMPT = "on";
		assert.equal(loadConfig(p).systemPrompt, true);
	} finally {
		if (prev === undefined) delete process.env.AGY_SYSTEM_PROMPT;
		else process.env.AGY_SYSTEM_PROMPT = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: turn caps default TTY-aware (headless 20m) and round-trip", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		// Headless branch pinned explicitly: the default must not depend on
		// ambient stdio (CI, piped vitest, TTY shells).
		stubTTY(false, () => {
			const c = loadConfig(p);
			assert.equal(c.turnTimeoutMin, 20);
			assert.equal(c.inactivityTimeoutMin, 5);
		});
		saveConfig({ turnTimeoutMin: 45, inactivityTimeoutMin: 0 }, p);
		const next = loadConfig(p);
		assert.equal(next.turnTimeoutMin, 45);
		assert.equal(next.inactivityTimeoutMin, 0);
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: turn cap defaults to 0 when stdout is a TTY", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		stubTTY(true, () => assert.equal(loadConfig(p).turnTimeoutMin, 0));
		stubTTY(false, () => assert.equal(loadConfig(p).turnTimeoutMin, 20));
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: turn cap sanity range 1-1440; out-of-range falls back to the TTY-aware default", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		stubTTY(false, () => {
			saveConfig({ turnTimeoutMin: 1440 }, p);
			assert.equal(loadConfig(p).turnTimeoutMin, 1440);
			saveConfig({ turnTimeoutMin: 1441 }, p);
			assert.equal(loadConfig(p).turnTimeoutMin, 20);
			saveConfig({ turnTimeoutMin: 0.5 }, p);
			assert.equal(loadConfig(p).turnTimeoutMin, 20);
		});
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: invalid turn cap values fall back to the defaults, 0 stays disabled", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		stubTTY(false, () => {
			saveConfig({ turnTimeoutMin: -3, inactivityTimeoutMin: "abc" as never }, p);
			const c = loadConfig(p);
			assert.equal(c.turnTimeoutMin, 20);
			assert.equal(c.inactivityTimeoutMin, 5);
		});
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: AGY_TURN_TIMEOUT_MIN env overrides the file, 0 disables", () => {
	const p = tmpConfig();
	const prev = process.env.AGY_TURN_TIMEOUT_MIN;
	try {
		saveConfig({ turnTimeoutMin: 45 }, p);
		process.env.AGY_TURN_TIMEOUT_MIN = "0";
		assert.equal(loadConfig(p).turnTimeoutMin, 0);
		process.env.AGY_TURN_TIMEOUT_MIN = "junk";
		stubTTY(false, () => assert.equal(loadConfig(p).turnTimeoutMin, 20));
		// Whitespace-only must fall back too, never read as an explicit 0/disable.
		process.env.AGY_TURN_TIMEOUT_MIN = "  ";
		stubTTY(false, () => assert.equal(loadConfig(p).turnTimeoutMin, 20));
	} finally {
		if (prev === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prev;
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: async loader shares cold reads and caches an unchanged file identity", async () => {
	const p = tmpConfig();
	fs.writeFileSync(p, JSON.stringify({ mode: "plan", bridgeTools: "mcp" }));
	const read = vi.spyOn(fs.promises, "readFile");
	const prev = process.env.AGY_MODE;
	try {
		const [first, concurrent] = await Promise.all([loadConfigAsync(p), loadConfigAsync(p)]);
		assert.equal(first.mode, "plan");
		assert.equal(concurrent.bridgeTools, "mcp");
		assert.equal(read.mock.calls.filter(([file]) => String(file) === p).length, 1);

		await loadConfigAsync(p);
		assert.equal(read.mock.calls.filter(([file]) => String(file) === p).length, 1, "same stat identity reuses the parse");
		process.env.AGY_MODE = "accept-edits";
		assert.equal((await loadConfigAsync(p)).mode, "accept-edits", "env still resolves per call");
	} finally {
		if (prev === undefined) delete process.env.AGY_MODE;
		else process.env.AGY_MODE = prev;
		read.mockRestore();
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});

test("config: async loader observes replacement and preserves corrupt-file behavior", async () => {
	const p = tmpConfig();
	try {
		fs.writeFileSync(p, JSON.stringify({ mode: "plan" }));
		assert.equal((await loadConfigAsync(p)).mode, "plan");
		fs.writeFileSync(p, JSON.stringify({ mode: "accept-edits", digest: true }));
		const changed = await loadConfigAsync(p);
		assert.equal(changed.mode, "accept-edits");
		assert.equal(changed.digest, true);

		fs.writeFileSync(p, "{broken");
		const corrupt = await loadConfigAsync(p);
		assert.equal(corrupt.mode, "accept-edits");
		assert.equal(corrupt.engine, "stream-json", "readable corrupt file is still an existing legacy install");
		fs.rmSync(p);
		assert.equal((await loadConfigAsync(p)).engine, "acp");
	} finally {
		fs.rmSync(path.dirname(p), { recursive: true, force: true });
	}
});
