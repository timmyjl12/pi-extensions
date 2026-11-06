// Skills discovery tests: pin scanSkills to pi's documented locations and
// per-location rules (pi docs/skills.md "Locations"). Real home is never
// touched: both projectDir and home are injected tmp dirs.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSkillBody, scanSkills, SKILL_SCAN_MAX_DIRECTORIES, skillLocations } from "../src/skills.js";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-"));
}

const SKILL_MD = (name: string, description: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function writeDirSkill(root: string, rel: string, name = path.basename(rel), description = `${name} does things`): void {
	const dir = path.join(root, rel);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD(name, description));
}

function writeMdSkill(root: string, file: string, name: string, description = `${name} does things`): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), SKILL_MD(name, description));
}

test("skills: global ~/.agents/skills grouping folders are discovered recursively", async () => {
	const home = tmp();
	writeDirSkill(path.join(home, ".agents", "skills"), "work/deployskill");
	const names = (await scanSkills(undefined, home)).map((s) => s.name);
	assert.ok(names.includes("deployskill"));
});

test("skills: agents-style ignores root .md, discovers grouping-folder .md with frontmatter", async () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	writeMdSkill(root, "loose.md", "loose-skill"); // root .md: ignored
	writeMdSkill(root, "work/notes.md", "notes"); // nested .md: discovered
	fs.mkdirSync(path.join(root, "work"), { recursive: true });
	fs.writeFileSync(path.join(root, "work", "nofrontmatter.md"), "# just prose\n"); // no frontmatter: ignored
	const names = (await scanSkills(undefined, home)).map((s) => s.name);
	assert.ok(!names.includes("loose-skill"));
	assert.ok(names.includes("notes"));
	assert.ok(!names.includes("nofrontmatter"));
});

test("skills: pi-style root .md files are individual skills", async () => {
	const home = tmp();
	writeMdSkill(path.join(home, ".pi", "agent", "skills"), "quick-note.md", "quick-note");
	assert.ok((await scanSkills(undefined, home)).some((s) => s.name === "quick-note"));
});

test("skills: entries without a description are not loaded", async () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	fs.mkdirSync(path.join(root, "undescribed"), { recursive: true });
	fs.writeFileSync(path.join(root, "undescribed", "SKILL.md"), "---\nname: undescribed\n---\nbody\n");
	writeMdSkill(root, "group/blank.md", "blank", "");
	const names = (await scanSkills(undefined, home)).map((s) => s.name);
	assert.ok(!names.includes("undescribed"));
	assert.ok(!names.includes("blank"));
});

test("skills: a skill dir is self-contained, no descent past SKILL.md", async () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	writeDirSkill(root, "outer");
	writeDirSkill(path.join(root, "outer"), "inner");
	assert.ok(!(await scanSkills(undefined, home)).some((s) => s.name === "inner"));
});

test("skills: project .pi/skills, project .agents/skills, and the git-root ancestor walk", async () => {
	const container = tmp();
	const repo = path.join(container, "repo");
	const project = path.join(repo, "services", "app");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	writeMdSkill(path.join(container, ".agents", "skills"), "above-repo.md", "above-repo"); // outside the walk
	writeDirSkill(path.join(repo, ".agents", "skills"), "repo-skill");
	writeDirSkill(path.join(project, ".agents", "skills"), "local-skill");
	writeMdSkill(path.join(project, ".pi", "skills"), "inline.md", "inline");

	const found = await scanSkills(project, container);
	const names = found.map((s) => s.name);
	assert.ok(names.includes("repo-skill"), "git-root ancestor discovered");
	assert.ok(names.includes("local-skill"), "project .agents/skills discovered");
	assert.ok(names.includes("inline"), "project .pi/skills root .md discovered");
	assert.ok(!names.includes("above-repo"), "walk stops at the git root");
});

test("skills: name collisions keep the first location (pi dir before agents dir)", async () => {
	const home = tmp();
	writeDirSkill(path.join(home, ".pi", "agent", "skills"), "dup", "dup", "from pi dir");
	writeDirSkill(path.join(home, ".agents", "skills"), "dup", "dup", "from agents dir");
	const dup = (await scanSkills(undefined, home)).find((s) => s.name === "dup");
	assert.equal(dup?.description, "from pi dir");
});

test("skills: a UTF-8 BOM does not break frontmatter detection", async () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	fs.mkdirSync(path.join(root, "bommed"), { recursive: true });
	fs.writeFileSync(path.join(root, "bommed", "SKILL.md"), `\uFEFF${SKILL_MD("bommed", "survives the BOM")}`);
	assert.ok((await scanSkills(undefined, home)).some((s) => s.name === "bommed"));
});

test("skills: hidden entries are skipped", async () => {
	const home = tmp();
	writeDirSkill(path.join(home, ".agents", "skills"), ".system/skill-creator");
	assert.ok(!(await scanSkills(undefined, home)).some((s) => s.name === "skill-creator"));
});

test("skills: location order is pi global, agents global, then project dirs", async () => {
	const home = tmp();
	const repo = path.join(tmp(), "repo");
	const project = path.join(repo, "proj");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const locs = (await skillLocations(project, home)).map((l) => l.dir);
	assert.deepEqual(locs, [
		path.join(home, ".pi", "agent", "skills"),
		path.join(home, ".agents", "skills"),
		path.join(project, ".pi", "skills"),
		path.join(project, ".agents", "skills"),
		path.join(repo, ".agents", "skills"),
	]);
});

test("skills: traversal stops at the directory budget", async () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	for (let i = 0; i < SKILL_SCAN_MAX_DIRECTORIES + 2; i++) {
		writeDirSkill(root, `group-${String(i).padStart(3, "0")}/skill`, `skill-${i}`);
	}
	const found = await scanSkills(undefined, home);
	assert.equal(found.length, SKILL_SCAN_MAX_DIRECTORIES - 1); // root consumes one slot
});

test("skills: body reads are async and preserve read failures as text", async () => {
	const home = tmp();
	const root = path.join(home, ".agents", "skills");
	writeDirSkill(root, "readable", "readable", "readable body");
	const skill = (await scanSkills(undefined, home)).find((s) => s.name === "readable");
	assert.ok(skill);
	assert.match(await readSkillBody(skill), /# readable/);
	fs.rmSync(skill.filePath);
	assert.match(await readSkillBody(skill), /^failed to read skill:/);
});
