import { spawnSync } from "node:child_process";

/**
 * Whether a native engine can actually be loaded here.
 *
 * Asked in a child process rather than by importing. A native module that is
 * installed but not built does not throw — rocksdb aborts the process with
 * `std::bad_alloc` from inside the library — and nothing in JavaScript can
 * catch a process that dies. The child absorbs that, and its exit status is
 * the answer.
 *
 * Answers for the three states that matter and cannot otherwise be told apart:
 * not installed, installed but unusable, and working.
 */
export const engineAvailable = (specifier) =>
  spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(specifier)}).then(() => process.exit(0), () => process.exit(1))`],
    { stdio: "ignore", timeout: 30_000 },
  ).status === 0;
