import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// What Claude Code itself writes for one person. Agent guidance lives in AGENTS.md and .agents/ (AGENTS.md § Agent Instruction Source Of Truth).
const ALLOWED = new Set(["settings.local.json", "worktrees"]);

const strays = (directory) => {
  try {
    return readdirSync(directory).filter((name) => !ALLOWED.has(name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

for (const where of [".", "pnotes"]) {
  test(`${where}/.claude holds nothing but Claude Code's own local state`, () => {
    assert.deepEqual(strays(join(root, where, ".claude")), [],
      "skills and references belong in .agents/, never in .claude/: remove what is listed");
  });
}
