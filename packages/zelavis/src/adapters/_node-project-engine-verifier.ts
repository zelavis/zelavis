import * as Effect from "effect/Effect";
import { createNodeRuntimeCatalog } from "./_node-runtime-catalog.js";
import { describeFailure } from "../core/runtime/effect-boundary.js";

// One-shot installed Project verifier. Only the qualified execution paths go
// back to the persistent host. The engine's configuration and keys stay there.
const [directory, rootOwned, version, digest, ...extra] = process.argv.slice(2);
if (!directory || (rootOwned !== "true" && rootOwned !== "false") || !version || extra.length ||
    (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest))) {
  throw new Error("Project engine verification requires a release directory, ownership policy and exact selection.");
}

const verify = Effect.gen(function* () {
  // A managed integration selects its exact Platform version. A native App
  // also supplies its pinned digest. Each invocation verifies the release once.
  const catalog = createNodeRuntimeCatalog({ directory, rootOwned: rootOwned === "true" }, new Map());
  const selected = digest === undefined ? yield* catalog.select(version) : { version, digest };
  const { executable, worker, module, cwd } = yield* catalog.resolve(selected, "project", {}, {});
  return { executable, worker, module, cwd };
});

Effect.runFork(verify.pipe(Effect.match({
  onSuccess: paths => console.log(JSON.stringify(paths)),
  onFailure: error => { console.error(describeFailure(error)); process.exitCode = 1; },
})));
