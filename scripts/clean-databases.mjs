#!/usr/bin/env node
/**
 * Wipes local database and emulator state that the examples and the dev UI
 * create at the repo root. Safe to run any time — the examples will recreate
 * everything they need on the next start.
 *
 * Usage:
 *   pnpm run clean:db
 *   pnpm run clean:db -- --dry-run   # list what would be deleted
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Directories that hold runtime state for an individual example or the
 * dev UI. Each entry is a path relative to the repo root. When the path
 * ends with `*`, the segment is treated as a glob across the parent dir.
 */
const TARGETS = [
  // pnpm dev creates `.zelavis/` inside the zelavis package because that's the cwd
  "packages/zelavis/.zelavis",

  // Legacy example state from before local adapters standardized on `.zelavis`
  "examples/*/.data",

  // Local runtime state created by examples and local adapters
  "examples/*/.zelavis",

  // Local emulator state from previous provider-backed examples
  "examples/*/.wrangler/state",
  "website/.wrangler/state",
];

async function expandGlob(pattern) {
  if (!pattern.includes("*")) {
    return [pattern];
  }

  const segments = pattern.split("/");
  const starIndex = segments.findIndex((segment) => segment.includes("*"));
  if (starIndex === -1) {
    return [pattern];
  }

  const parentSegments = segments.slice(0, starIndex);
  const starSegment = segments[starIndex];
  const tailSegments = segments.slice(starIndex + 1);
  const parentPath = join(REPO_ROOT, ...parentSegments);

  if (!existsSync(parentPath)) {
    return [];
  }

  const entries = await readdir(parentPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (starSegment === "*" || matchSimpleGlob(starSegment, entry.name)) {
      const expanded = join(
        ...parentSegments,
        entry.name,
        ...tailSegments,
      );
      const nested = await expandGlob(expanded);
      results.push(...nested);
    }
  }
  return results;
}

function matchSimpleGlob(pattern, name) {
  // Only `*` wildcards are supported (matches any chars except `/`).
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
  );
  return regex.test(name);
}

function describeTarget(absolutePath) {
  try {
    const info = statSync(absolutePath);
    if (info.isDirectory()) {
      return "dir";
    }
    return "file";
  } catch {
    return "?";
  }
}

async function main() {
  const matches = new Set();
  for (const pattern of TARGETS) {
    for (const expanded of await expandGlob(pattern)) {
      const absolutePath = join(REPO_ROOT, expanded);
      if (existsSync(absolutePath)) {
        matches.add(absolutePath);
      }
    }
  }

  if (matches.size === 0) {
    console.log("Nothing to clean.");
    return;
  }

  const verb = DRY_RUN ? "Would remove" : "Removing";
  for (const target of matches) {
    const kind = describeTarget(target);
    console.log(`${verb} (${kind}): ${relative(REPO_ROOT, target)}`);
    if (!DRY_RUN) {
      rmSync(target, { recursive: true, force: true });
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry run — ${matches.size} target(s) would be removed.`);
  } else {
    console.log(`\nRemoved ${matches.size} target(s).`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
