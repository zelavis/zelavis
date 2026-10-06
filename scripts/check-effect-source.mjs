#!/usr/bin/env node
import { checkReferences, repositoryRoot } from "./reference-sources.mjs";
try {
  console.log(checkReferences(repositoryRoot));
} catch (error) {
  console.error(`Effect reference check failed: ${error.message}`);
  process.exitCode = 1;
}
