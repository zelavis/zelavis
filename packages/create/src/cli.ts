#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import {
  HELP,
  createProject,
  nextSteps,
  packageManagerFromUserAgent,
  parseArguments,
} from "./index.js";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.version) {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`${version}\n`);
    return;
  }

  let directory = parsed.directory;
  if (directory === undefined) {
    if (parsed.yes || !process.stdin.isTTY) {
      directory = "zelavis";
    } else {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      directory = (await prompt.question("Where should the Platform go? (zelavis) ")).trim() || "zelavis";
      prompt.close();
    }
  }

  const project = await createProject({
    directory,
    install: parsed.install,
    git: parsed.git,
    packageManager: parsed.packageManager ?? packageManagerFromUserAgent(process.env.npm_config_user_agent),
  });
  const shown = relative(process.cwd(), project.directory) || ".";
  // A folder outside the current one is shown as its full path, not as ../../..
  process.stdout.write(nextSteps(project, shown.startsWith("..") ? project.directory : shown));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
