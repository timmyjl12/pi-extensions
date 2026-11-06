// pi Agent Skills catalog + activate_skill bridge.
//
// The MCP bridge exposes ONE `activate_skill` tool to agy whose JSON-schema
// enum is the catalog; the description carries each skill's one-liner so agy
// can tell when a skill applies. Calling it returns the full SKILL.md plus the
// bundled resource dir. Nothing is appended to the prompt: agy sees the
// catalog in tools/list on every spawn, including after pi compaction.

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";

export interface SkillLite {
	name: string;
	description: string;
	/** Absolute path to SKILL.md. */
	filePath: string;
	/** Absolute directory containing SKILL.md and bundled resources. */
	dir: string;
}

/** Parse `name:` / `description:` out of SKILL.md frontmatter. Deliberately
 *  line-based, not YAML: multi-line block scalars (`description: >-`) keep
 *  only their first line. */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of m[1].split(/\r?\n/)) {
		const name = line.match(/^name:\s*(.+)$/);
		if (name && !out.name) out.name = name[1].trim();
		const desc = line.match(/^description:\s*(.+)$/);
		if (desc && !out.description) out.description = desc[1].trim();
	}
	return out;
}

// The rest of this module mirrors pi's own skill discovery (pi docs
// "docs/skills.md - Locations") so the bridge's activate_skill catalog
// matches the [Skills] list pi shows in its system prompt:
//
// - Global: ~/.pi/agent/skills (pi style) and ~/.agents/skills (agents style,
//   the cross-harness standard).
// - Project: .pi/skills (pi style) and .agents/skills in cwd + ancestors up
//   to the git repo root (agents style).
// - Both styles discover every directory holding a SKILL.md, recursively;
//   grouping folders (no SKILL.md) are descended into and a skill's contents
//   are freeform (no descent past its SKILL.md).
// - pi style also treats root .md files as individual skills; agents style
//   ignores root .md but picks up frontmatter .md files inside grouping
//   folders.
// - Skills without a description are not loaded (same as pi).
// - Name collisions keep the first skill found, pi global dirs before
//   project dirs.

export type SkillStyle = "pi" | "agents";

export interface SkillLocation {
	dir: string;
	style: SkillStyle;
}

const MAX_DEPTH = 16; // symlink-loop insurance; real catalogs nest 1-2 levels
export const SKILL_SCAN_MAX_DIRECTORIES = 128;
const SKILL_SCAN_MAX_ENTRIES = 4096;
const SKILL_SCAN_MAX_ENTRIES_PER_DIRECTORY = 512;

async function pathExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/** Ordered skill locations for a session: pi global dirs, then project dirs
 *  (project `.agents/skills` walks cwd ancestors up to the git root). */
export async function skillLocations(projectDir?: string, home: string = os.homedir()): Promise<SkillLocation[]> {
	const out: SkillLocation[] = [
		{ dir: path.join(home, ".pi", "agent", "skills"), style: "pi" },
		{ dir: path.join(home, ".agents", "skills"), style: "agents" },
	];
	if (!projectDir) return out;
	out.push({ dir: path.join(projectDir, ".pi", "skills"), style: "pi" });
	let dir = path.resolve(projectDir);
	for (;;) {
		out.push({ dir: path.join(dir, ".agents", "skills"), style: "agents" });
		if (path.dirname(dir) === dir || (await pathExists(path.join(dir, ".git")))) break;
		dir = path.dirname(dir);
	}
	return out;
}

async function readSkillFile(file: string, fallbackName: string): Promise<SkillLite | null> {
	let raw = "";
	try {
		// Strip a UTF-8 BOM so editors that add one do not break the `---` anchor.
		raw = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
	} catch {
		return null;
	}
	const fm = parseFrontmatter(raw);
	const description = (fm.description ?? "").trim();
	// pi does not load skills without a description.
	if (!description) return null;
	return {
		name: fm.name?.trim() || fallbackName,
		description: description.replace(/\s+/g, " ").slice(0, 160),
		filePath: file,
		dir: path.dirname(file),
	};
}

async function scanLocation(loc: SkillLocation): Promise<SkillLite[]> {
	const budget = { directories: 0, entries: 0 };
	const walk = async (dir: string, depth: number): Promise<SkillLite[]> => {
		if (depth > MAX_DEPTH || budget.directories >= SKILL_SCAN_MAX_DIRECTORIES) return [];
		budget.directories++;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const found: SkillLite[] = [];
		for (const entry of entries.slice(0, SKILL_SCAN_MAX_ENTRIES_PER_DIRECTORY)) {
			if (budget.entries >= SKILL_SCAN_MAX_ENTRIES) break;
			budget.entries++;
			// Hidden entries are harness internals (e.g. ~/.agents/skills/.system);
			// pi's own [Skills] list never includes them.
			if (entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			let isDir: boolean;
			try {
				isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await fs.stat(full)).isDirectory());
			} catch {
				continue;
			}
			if (isDir) {
				const skillFile = path.join(full, "SKILL.md");
				if (await pathExists(skillFile)) {
					const skill = await readSkillFile(skillFile, entry.name);
					if (skill) found.push(skill);
				} else {
					found.push(...await walk(full, depth + 1));
				}
				continue;
			}
			if (!entry.name.endsWith(".md") || entry.name === "SKILL.md") continue;
			const standalone = loc.style === "pi" ? depth === 0 : depth > 0;
			if (!standalone) continue;
			const skill = await readSkillFile(full, entry.name.replace(/\.md$/, ""));
			if (skill) found.push(skill);
		}
		return found;
	};
	return walk(loc.dir, 0);
}

/** pi-faithful skill catalog: every skill pi itself would load, deduped by
 *  name (first wins). `home` is injectable for tests. */
export async function scanSkills(projectDir?: string, home: string = os.homedir()): Promise<SkillLite[]> {
	const seen = new Set<string>();
	const out: SkillLite[] = [];
	for (const loc of await skillLocations(projectDir, home)) {
		for (const skill of await scanLocation(loc)) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			out.push(skill);
		}
	}
	return out;
}

export function findSkillByName(skills: SkillLite[], name: string): SkillLite | undefined {
	return skills.find((s) => s.name === name);
}

/** One-liner list for the tool description: `- name: description`. */
export function catalogSummary(skills: SkillLite[]): string {
	return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/** Full body handed to agy when it activates a skill. */
export async function readSkillBody(skill: SkillLite): Promise<string> {
	try {
		return await fs.readFile(skill.filePath, "utf8");
	} catch (err) {
		return `failed to read skill: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** JSON schema for the activate_skill bridge tool. */
export function activateSkillSchema(skills: SkillLite[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			name: {
				type: "string",
				enum: skills.map((s) => s.name),
				description: "Skill name from the catalog in this tool's description.",
			},
		},
		required: ["name"],
	};
}
