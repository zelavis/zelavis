/**
 * The Zelavis command line.
 *
 * Split in two on purpose: this module parses arguments and describes commands
 * without knowing how to start anything, and `src/cli.ts` is the binary that
 * gives it a real runtime. That seam is what lets the command surface be
 * exercised without booting a Platform.
 *
 * It lives inside `zelavis` rather than beside it because a CLI is not
 * swappable the way a frontend is — nobody installs a different one — and a
 * separate package would publish an artifact with one consumer and a version
 * that must always match this one.
 */
export * from "./agent.js";
export * from "./bootstrap.js";
export * from "./commands.js";
export * from "./services.js";
