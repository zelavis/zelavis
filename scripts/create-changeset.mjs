import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , bumpType, summary, ...packages] = process.argv;
const allowedBumpTypes = new Set(["patch", "minor", "major", "empty"]);

if (!allowedBumpTypes.has(bumpType)) {
  console.error(
    'Usage: pnpm changeset:add <patch|minor|major|empty> "summary" [package...]',
  );
  process.exit(1);
}

if (!summary?.trim()) {
  console.error("A summary is required.");
  process.exit(1);
}

if (bumpType !== "empty" && packages.length === 0) {
  console.error("At least one package name is required.");
  process.exit(1);
}

const uniquePackages = [...new Set(packages)].sort();
const changesetDir = join(process.cwd(), ".changeset");
mkdirSync(changesetDir, { recursive: true });

const slug = `${
  summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "release"
}-${randomUUID().slice(0, 8)}`;

const filePath = join(changesetDir, `${slug}.md`);
const frontmatter = uniquePackages
  .map((name) => `"${name}": ${bumpType}`)
  .join("\n");
const content = frontmatter
  ? `---\n${frontmatter}\n---\n\n${summary.trim()}\n`
  : `---\n---\n\n${summary.trim()}\n`;

writeFileSync(filePath, content, "utf8");

console.log(`Created ${filePath}`);
