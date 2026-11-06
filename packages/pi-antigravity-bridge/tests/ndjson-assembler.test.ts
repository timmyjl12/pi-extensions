import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "vitest";
import { NdjsonFrameAssembler } from "../src/ndjson-assembler.js";

describe("NdjsonFrameAssembler", () => {
	test("reassembles split frames, emits multiple frames in order, and retains only the tail", () => {
		const frames: string[] = [];
		const assembler = new NdjsonFrameAssembler(1024);
		assert.equal(assembler.push('{"one":1}\r\n{"two"', (line) => frames.push(line)), undefined);
		assert.deepEqual(frames, ['{"one":1}\r']);
		assert.equal(assembler.bufferedLength, 6);
		assert.equal(assembler.push(':2}\n\n{"three":3}\n{"tail"', (line) => frames.push(line)), undefined);
		assert.deepEqual(frames, ['{"one":1}\r', '{"two":2}', "", '{"three":3}']);
		assert.equal(assembler.bufferedLength, 7);
		assert.equal(assembler.push(":4}", (line) => frames.push(line)), undefined);
		assert.deepEqual(frames.length, 4, "an unterminated tail is not emitted");
		assert.equal(assembler.push("\n", (line) => frames.push(line)), undefined);
		assert.equal(frames.at(-1), '{"tail":4}');
		assert.equal(assembler.bufferedLength, 0);
	});

	test("enforces the per-frame cap and recovers after the caller handles overflow", () => {
		const assembler = new NdjsonFrameAssembler(8);
		assert.equal(assembler.push("12345678", () => assert.fail("no frame yet")), undefined);
		assert.equal(assembler.push("9", () => assert.fail("overflow must not emit")), 9);
		assert.equal(assembler.bufferedLength, 0);
		const frames: string[] = [];
		assert.equal(assembler.push("ok\n", (line) => frames.push(line)), undefined);
		assert.deepEqual(frames, ["ok"]);
	});

	test("joins a large partial frame once when its newline arrives", () => {
		const payload = "x".repeat(2 * 1024 * 1024);
		const frames: string[] = [];
		const assembler = new NdjsonFrameAssembler(3 * 1024 * 1024);
		for (let offset = 0; offset < payload.length; offset += 8191) {
			assert.equal(
				assembler.push(payload.slice(offset, offset + 8191), (line) => frames.push(line)),
				undefined,
			);
		}
		assert.equal(frames.length, 0);
		assembler.push("\n", (line) => frames.push(line));
		assert.deepEqual(frames, [payload]);
	});

	test("bounded 4 MiB fragmented-frame benchmark", () => {
		const payload = "z".repeat(4 * 1024 * 1024);
		const assembler = new NdjsonFrameAssembler(5 * 1024 * 1024);
		let output = "";
		const started = performance.now();
		for (let offset = 0; offset < payload.length; offset += 256) {
			assembler.push(payload.slice(offset, offset + 256), (line) => {
				output = line;
			});
		}
		assembler.push("\n", (line) => {
			output = line;
		});
		const elapsedMs = performance.now() - started;
		assert.equal(output.length, payload.length);
		assert.ok(elapsedMs < 2_000, `4 MiB fragmented frame took ${elapsedMs.toFixed(1)}ms`);
	});
});
