#!/usr/bin/env node
// Zelavis Auth is derived from Convex Auth. Every derived file carries a
// provenance header and an entry in packages/zelavis/src/auth/upstream.json;
// `checkAuthProvenance` holds the two to each other (run by
// scripts/test/auth-provenance.test.mjs, needing no checkout), and
// `pnpm auth:upstream` reads the repos/convex-auth reference checkout to list
// what upstream changed since the pin. It is read-only apart from fetching
// the official origin into that checkout.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { convexAuthOrigin, repositoryRoot, sourceRecord } from "./reference-sources.mjs";

export const upstreamRepository = "https://github.com/convex/convex-auth";
export const upstreamSourceRoot = "packages/core/src";
const authenticatorSource = "packages/passkey-test-authenticator/src";
const authenticatorFixtures = "test/fixtures/passkey-authenticator";
const commitId = /^[0-9a-f]{40}$/;
const kinds = new Set(["translated", "copied"]);
const runGit = (args, cwd) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();

/** The provenance header a derived file starts with, line by line. */
export function provenanceHeader(upstreamPath, commit, change) {
  return [
    `// Derived from Convex Auth (https://github.com/convex/convex-auth), ${upstreamPath}`,
    `// at ${commit}. Copyright 2026 Convex, Inc.`,
    "// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.",
    `// Modified for Zelavis: ${change}.`,
  ];
}

const firstLine = /^\/\/ Derived from Convex Auth \(https:\/\/github\.com\/convex\/convex-auth\), (\S+)$/;
const changeLine = /^\/\/ Modified for Zelavis: .+\.$/;

/**
 * Reads a file's provenance header. Returns null when the file does not
 * mention Convex Auth at all, `{ upstream }` for a complete header, and
 * `{ error }` for a header that is present but malformed or names another pin.
 */
export function readProvenanceHeader(text, commit) {
  const lines = text.split("\n", 4);
  const match = firstLine.exec(lines[0] ?? "");
  if (!match) return text.includes("Derived from Convex Auth") ? { error: "mentions Convex Auth without starting with the provenance header" } : null;
  const expected = provenanceHeader(match[1], commit, "x");
  if (lines[1] !== expected[1]) return { error: `header line 2 must name the pinned commit: ${expected[1]}` };
  if (lines[2] !== expected[2]) return { error: `header line 3 must be: ${expected[2]}` };
  if (!changeLine.test(lines[3] ?? "")) return { error: "header line 4 must state the modification: // Modified for Zelavis: <change>." };
  return { upstream: match[1] };
}

function listTypeScript(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listTypeScript(path));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Checks the derived files under `<sourceRoot>/auth` against `record`
 * (upstream.json) and the pinned commit. Returns a list of problems; an empty
 * list means every derived file is recorded and every record names a derived
 * file.
 */
export function checkAuthProvenance({ sourceRoot, packageRoot = join(sourceRoot, ".."), record, pinnedCommit }) {
  const problems = [];
  if (record.repository !== upstreamRepository) problems.push(`upstream.json repository must be ${upstreamRepository}`);
  if (record.commit !== pinnedCommit) problems.push(`upstream.json commit ${record.commit} differs from the convex-auth pin ${pinnedCommit} in scripts/reference-sources.json`);
  if (!Array.isArray(record.files)) problems.push("upstream.json files must be a list");
  if (!Array.isArray(record.omitted)) problems.push("upstream.json omitted must be a list");
  if (problems.length > 0) return problems;
  for (const entry of record.omitted) {
    if (typeof entry?.upstream !== "string" || !entry.upstream.startsWith(`${upstreamSourceRoot}/`) || typeof entry.reason !== "string" || entry.reason.length === 0) {
      problems.push(`omitted entry ${JSON.stringify(entry)} needs an upstream path under ${upstreamSourceRoot} and a reason`);
    }
  }
  const byPath = new Map();
  for (const entry of record.files) {
    const label = JSON.stringify(entry?.path);
    const fixture = typeof entry?.path === "string" && entry.path.startsWith(`${authenticatorFixtures}/`);
    if (typeof entry?.path !== "string" || (!fixture && !entry.path.startsWith("auth/") && !/^sdk\/auth-[a-z-]+\.ts$/u.test(entry.path))) { problems.push(`file entry ${JSON.stringify(entry)} needs an Auth source or authenticator fixture path`); continue; }
    if (byPath.has(entry.path)) problems.push(`file ${label} has more than one entry`);
    byPath.set(entry.path, entry);
    const upstreamRoot = fixture ? authenticatorSource : upstreamSourceRoot;
    if (typeof entry.upstream !== "string" || !entry.upstream.startsWith(`${upstreamRoot}/`)) problems.push(`file ${label} needs an upstream path under ${upstreamRoot}`);
    if (!commitId.test(entry.blob ?? "")) problems.push(`file ${label} needs a 40-hex git blob`);
    if (entry.additionalSources !== undefined && (!Array.isArray(entry.additionalSources)
      || entry.additionalSources.some(source => typeof source?.upstream !== "string"
        || !source.upstream.startsWith(`${upstreamRoot}/`) || !commitId.test(source.blob ?? "")))) {
      problems.push(`file ${label} has an invalid additional upstream source`);
    }
    if (!kinds.has(entry.kind)) problems.push(`file ${label} kind must be "translated" or "copied"`);
    const path = join(fixture ? packageRoot : sourceRoot, entry.path);
    if (!existsSync(path)) { problems.push(`file ${label} is recorded but does not exist`); continue; }
    const header = readProvenanceHeader(readFileSync(path, "utf8"), record.commit);
    if (header === null) problems.push(`file ${label} is recorded but does not start with the provenance header`);
    else if (header.error) problems.push(`file ${label}: ${header.error}`);
    else if (header.upstream !== entry.upstream) problems.push(`file ${label} header names ${header.upstream}, its entry ${entry.upstream}`);
  }
  const files = [
    ...listTypeScript(join(sourceRoot, "auth")).map((file) => [sourceRoot, file]),
    ...listTypeScript(join(sourceRoot, "sdk")).map((file) => [sourceRoot, file]),
    ...listTypeScript(join(packageRoot, authenticatorFixtures)).map((file) => [packageRoot, file]),
  ];
  for (const [root, file] of files) {
    const path = relative(root, file).split(sep).join("/");
    const header = readProvenanceHeader(readFileSync(file, "utf8"), record.commit);
    if (header === null) continue;
    if (header.error) { if (!byPath.has(path)) problems.push(`file "${path}": ${header.error}`); continue; }
    if (!byPath.has(path)) problems.push(`file "${path}" carries the provenance header but has no entry in upstream.json`);
  }
  return problems;
}

function segmentPattern(segment) {
  return new RegExp(`^${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
}

// An omitted pattern names a file or a directory; `*` matches within one path
// segment and `**` any number of segments.
export function matchesOmitted(pattern, path) {
  const want = pattern.split("/");
  const have = path.split("/");
  const match = (i, j) => {
    if (i === want.length) return true; // a matched directory covers everything below it
    if (want[i] === "**") return match(i + 1, j) || (j < have.length && match(i, j + 1));
    return j < have.length && segmentPattern(want[i]).test(have[j]) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

const isTest = (path) => /\.test\.tsx?$/.test(path);

function treeAt(checkout, rev) {
  const tree = new Map();
  for (const line of runGit(["ls-tree", "-r", rev, "--", upstreamSourceRoot, authenticatorSource], checkout).split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    tree.set(path, meta.split(" ")[2]);
  }
  return tree;
}

/** Lists what upstream changed at `rev` relative to the recorded files. */
export function upstreamReport({ checkout, record, rev }) {
  const pinned = treeAt(checkout, record.commit);
  const current = treeAt(checkout, rev);
  const files = record.files.flatMap(entry => [entry, ...(entry.additionalSources ?? []).map(source => ({
    path: entry.path, kind: entry.kind, ...source,
  }))]);
  const recorded = new Set(files.map((entry) => entry.upstream));
  return {
    misrecorded: files.filter((entry) => pinned.get(entry.upstream) !== entry.blob),
    changed: files.filter((entry) => current.has(entry.upstream) && current.get(entry.upstream) !== entry.blob),
    gone: files.filter((entry) => !current.has(entry.upstream)),
    unaccounted: [...current.keys()].filter((path) => path.endsWith(".ts") || path.endsWith(".tsx")).filter((path) => !isTest(path) && !recorded.has(path) && !record.omitted.some((entry) => matchesOmitted(entry.upstream, path))).sort(),
  };
}

function main(argv) {
  let rev;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--ref" && argv[i + 1]) rev = argv[(i += 1)];
    else throw new Error("Usage: pnpm auth:upstream [--ref <rev>]");
  }
  const checkout = join(repositoryRoot, "repos/convex-auth");
  if (!existsSync(join(checkout, ".git"))) {
    console.error("repos/convex-auth is missing; run pnpm refs:sync first.");
    return 2;
  }
  const record = JSON.parse(readFileSync(join(repositoryRoot, "packages/zelavis/src/auth/upstream.json"), "utf8"));
  const pin = sourceRecord(repositoryRoot)["convex-auth"].commit;
  const problems = checkAuthProvenance({ sourceRoot: join(repositoryRoot, "packages/zelavis/src"), record, pinnedCommit: pin });
  if (problems.length > 0) throw new Error(`Provenance records are inconsistent:\n  ${problems.join("\n  ")}`);
  if (rev === undefined) {
    if (runGit(["remote", "get-url", "origin"], checkout) !== convexAuthOrigin) throw new Error(`repos/convex-auth origin is not ${convexAuthOrigin}; run pnpm refs:sync.`);
    runGit(["fetch", "--quiet", "--depth=1", "origin", "main"], checkout);
    rev = "origin/main";
  }
  const resolved = runGit(["rev-parse", `${rev}^{commit}`], checkout);
  const report = upstreamReport({ checkout, record, rev: resolved });
  console.log(`Convex Auth pin ${record.commit}; comparing with ${rev} (${resolved}).`);
  const section = (title, rows) => {
    console.log(`\n${title}: ${rows.length}`);
    for (const row of rows) console.log(`  ${row}`);
  };
  section("Recorded blob differs from the pin (fix upstream.json)", report.misrecorded.map((entry) => `${entry.path} <- ${entry.upstream}`));
  section("Changed upstream since the pin", report.changed.map((entry) => `${entry.path} <- ${entry.upstream}`));
  section("Gone upstream", report.gone.map((entry) => `${entry.path} <- ${entry.upstream}`));
  section("Upstream files neither ported nor omitted", report.unaccounted);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`auth:upstream failed: ${error.message}`);
    process.exitCode = 1;
  }
}
