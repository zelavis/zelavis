#!/usr/bin/env node
// The last step of `pnpm release:check`: names the commit that was just qualified, so publishing it
// does not run the same 40 minutes of checks again while the owner waits for npm's 2FA prompt.
import { execFileSync } from "node:child_process";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git(["status", "--porcelain", "--untracked-files=no"]) !== "") {
  console.error("The tree changed while it was being qualified; commit, then run `pnpm release:check` again.");
  process.exit(1);
}
const head = git(["rev-parse", "HEAD"]);
console.log(`Qualified ${head}. Publish exactly this commit with:`);
console.log(`  ZELAVIS_RELEASE_QUALIFIED=${head} pnpm release:publish:<alpha|latest>`);
