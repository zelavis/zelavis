#!/usr/bin/env node
import { repositoryRoot, syncReferences } from "./reference-sources.mjs";
try {
  if (process.argv.length > 2) throw new Error("Usage: pnpm refs:sync (the version is derived from workspace manifests).");
  console.log(syncReferences(repositoryRoot));
} catch (error) {
  console.error(`Reference sync failed: ${error.message}`);
  process.exitCode = 1;
}
