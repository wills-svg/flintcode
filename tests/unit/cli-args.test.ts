import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { parseArgs } from "../../src/cli/args.js";

test("parseArgs keeps resource commands and their raw arguments", () => {
	const parsed = parseArgs(["sessions", "delete", "abc", "--yes"], { cwd: "/repo" });
	assert.equal(parsed.args.command, "sessions");
	assert.deepEqual(parsed.args.commandArgs, ["delete", "abc", "--yes"]);
	assert.equal(parsed.errors.length, 0);
});

test("parseArgs supports flags, inline values, resume and prompt positionals", () => {
	const parsed = parseArgs(
		[
			"-p",
			"--model=kilo/kilo-auto/free",
			"--thinking",
			"low",
			"--resume",
			"session-1",
			"hello",
			"world",
		],
		{ cwd: "/repo" },
	);
	assert.equal(parsed.args.mode, "print");
	assert.equal(parsed.args.model, "kilo/kilo-auto/free");
	assert.equal(parsed.args.thinking, "low");
	assert.equal(parsed.args.resume, "session-1");
	assert.equal(parsed.args.prompt, "hello world");
	assert.equal(parsed.errors.length, 0);
});

test("parseArgs validates permission and output modes", () => {
	const yolo = parseArgs(["--yolo"], { cwd: "/repo" });
	assert.equal(yolo.args.permissionMode, "yolo");
	const invalid = parseArgs(["--permission-mode", "nope"], { cwd: "/repo" });
	assert.match(invalid.errors[0] ?? "", /Invalid --permission-mode/);
	const format = parseArgs(["-o", "json", "x"], { cwd: "/repo" });
	assert.equal(format.args.mode, "json");
	assert.equal(format.args.outputFormat, "json");
	const unknown = parseArgs(["--nope"], { cwd: "/repo" });
	assert.match(unknown.errors[0] ?? "", /Unknown option/);
});

test("parseArgs resolves options relative to the selected cwd", () => {
	const parsed = parseArgs(["-w", "project", "--add-dir", "extra", "prompt"], { cwd: "/base" });
	assert.equal(parsed.args.cwd, path.resolve("/base", "project"));
	assert.deepEqual(parsed.args.addDirs, [path.resolve(parsed.args.cwd, "extra")]);
});
