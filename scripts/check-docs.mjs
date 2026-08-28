import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const repoRoot = process.cwd();
const docsRoot = "website/src/content/docs";
const targets = [
  docsRoot,
  "packages/zelavis/README.md",
  "packages/zelavis/ARCHITECTURE.md",
  "packages/zelavis/TODO.md",
  "packages/zelavis/product-services/zelavis-ui/README.md",
];

const stalePatterns = [
  {
    pattern: /\bintegrations\b/i,
    message: 'Use "adapters" instead of "integrations" in current docs.',
  },
  {
    pattern: /not yet served by `zelavis\(\)`/i,
    message: "UI docs still claim the dashboard is not served by zelavis.",
  },
  {
    pattern: /dashboard, auth, and database core services/i,
    message:
      "Docs still describe the default core services without the website service.",
  },
  {
    pattern: /devServerUrl:\s*"http:\/\/127\.0\.0\.1:3001"/i,
    message:
      "Mounted dashboard dev URLs should include /zelavis when documented directly.",
  },
  {
    pattern: /@zelavis\/adapter-[a-z-]+|@zelavis\/adapter-turso/i,
    message: "Docs reference old adapter package names.",
  },
  {
    pattern: /Use `docs\/` as the canonical home/i,
    message: "Docs still point at the removed docs/ folder as canonical.",
  },
  {
    pattern: /core `@zelavis\/server` service/i,
    message:
      "Docs assign Zelavis product authority to the reusable zelavis/core package.",
  },
];

const failures = [];

function readTarget(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function listFiles(target) {
  const output = execSync(`find ${target} -type f`, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  return output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter(
      (value) => value.endsWith(".md") || value.endsWith(".mdx"),
    );
}

for (const target of targets) {
  if (target.endsWith(".md")) {
    continue;
  }

  for (const file of listFiles(target)) {
    const content = readTarget(file);
    for (const { pattern, message } of stalePatterns) {
      if (pattern.test(content)) {
        failures.push(`${file}: ${message}`);
      }
    }
  }
}

for (const file of targets.filter((value) => value.endsWith(".md"))) {
  const content = readTarget(file);
  for (const { pattern, message } of stalePatterns) {
    if (pattern.test(content)) {
      failures.push(`${file}: ${message}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Docs check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Docs check passed.");
