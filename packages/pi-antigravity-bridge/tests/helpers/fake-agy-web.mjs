#!/usr/bin/env node
// Fake `agy` for web-tools tests: emits scripted NDJSON frames per FIXTURE_MODE.
// Modes: ok, ok-read, no-search (answer with no tool step), drift-ok (state OK
// + result OK, older-build spelling), unexpected (disallowed tool fires),
// fail (result ERROR), slow (answers after the host deadline).
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const get = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};
const agent = get("--agent");
const mode = process.env.FIXTURE_MODE ?? "ok";
const record = process.env.FIXTURE_RECORD;
const root = process.env.FIXTURE_ROOT ?? "";

const dirOf = () => `${root}/${agent}`;
const note = (dirExists) => {
	if (record) appendFileSync(record, `${JSON.stringify({ agent, dirExists })}\n`);
};

const line = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const step = (tool, state) =>
	line({ event: "step_update", step_update: { step_index: 2, state, step_type: "tool", tool_name: tool } });

note(existsSync(dirOf()));

if (mode === "slow") {
	setTimeout(() => {
		line({ event: "result", result: { status: "SUCCESS", response: "TOO LATE" } });
	}, 400);
} else if (mode === "split-unicode") {
	line({ event: "init", init: { cwd: process.cwd(), agent } });
	step("search_web", "DONE");
	const payload = Buffer.from(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "FAKE 😀 漢字" } })}\n`, "utf8");
	// Split inside the four-byte emoji, not merely between JSON tokens.
	const splitAt = payload.indexOf(Buffer.from("😀", "utf8")) + 2;
	process.stdout.write(payload.subarray(0, splitAt));
	setTimeout(() => process.stdout.write(payload.subarray(splitAt)), 20);
} else if (mode === "overflow" || mode === "unexpected-flood") {
	line({ event: "init", init: { cwd: process.cwd(), agent } });
	step(mode === "unexpected-flood" ? "run_command" : "search_web", "ACTIVE");
	// Keep writing after the host must fail. There is deliberately no NDJSON
	// newline, so early-return retention is exercised as well as the total cap.
	let remaining = 4 * 1024 * 1024;
	const flood = () => {
		if (remaining <= 0) return;
		const size = Math.min(64 * 1024, remaining);
		remaining -= size;
		process.stdout.write("x".repeat(size), () => setImmediate(flood));
	};
	flood();
} else if (mode === "partial-result") {
	line({ event: "init", init: { cwd: process.cwd(), agent } });
	step("search_web", "DONE");
	const complete = `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "MUST NOT EMIT" } })}\n`;
	process.stdout.write(complete.slice(0, -3));
} else {
	line({ event: "init", init: { cwd: process.cwd(), agent, tools: ["search_web", "read_url_content"] } });
	const tool = mode === "ok-read" || mode === "read-no-fetch" ? "read_url_content" : "search_web";
	if (mode === "ok" || mode === "ok-read") {
		step(tool, "ACTIVE");
		step(tool, "DONE");
	}
	if (mode === "drift-ok") step(tool, "OK");
	if (mode === "unexpected") step("run_command", "ACTIVE");
	note(existsSync(dirOf()));
	const status = mode === "drift-ok" ? "OK" : mode === "fail" ? "ERROR" : "SUCCESS";
	line({ event: "result", result: { status, response: status === "ERROR" ? "" : "FAKE ANSWER" } });
}
