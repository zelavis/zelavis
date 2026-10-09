/**
 * What a Project recipe needs to provide the runtime its Projects run under.
 *
 * A recipe whose Projects are not Zelavis apps (WordPress, for one) ships its
 * own runtime in its package instead of the Platform hard-coding it. Its
 * `package.json` declares `zelavis.project.runtime` (a path inside the package),
 * and that module exports `createProjectRuntime(context)` returning a driver.
 *
 * This is host code: it starts and stops processes with the Platform's
 * authority. The Platform only loads one from a recipe it has been told may
 * provide a runtime, and only from the frozen, digest-verified copy inside the
 * Project, never from the installed package it was copied from.
 */
export { ZelavisProjectRuntimeError } from "../project.js";
export type {
  ZelavisProjectDescriptor,
  ZelavisProjectLogEntry,
  ZelavisProjectRecipeLock,
  ZelavisProjectRecord,
  ZelavisProjectRuntimeDriver,
  ZelavisProjectRuntimeSnapshot,
} from "../project.js";
export type {
  ZelavisAgentProcess,
  ZelavisAgentProcessRunner,
} from "../core/agent/process-command.js";
export { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
export { createRecipeProjectRuntime, type RecipeProjectRuntimeOptions } from "./_recipe-project-runtime.js";

import type { ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import type { ZelavisProjectRuntimeDriver } from "../project.js";

/** What the Platform hands a recipe's runtime when it creates it. */
export interface ZelavisRecipeRuntimeContext {
  /** The directory holding every Project's directory. */
  readonly directory: string;
  /** The recipe's own package folder: the digest-verified frozen copy this runtime was loaded from. */
  readonly packageDirectory: string;
  /** The Agent that executes this host's Project processes. */
  readonly agent: ZelavisAgentProcessRunner;
  /**
   * Another version of this recipe, for upgrading a running Project to it. `source` finds the
   * package of that exact name and version on this host, or nothing; `stage` freezes a package into
   * a data directory and returns its content digest. Trust in the recipe is the Platform's, decided
   * before a runtime is created.
   */
  readonly recipes: {
    readonly source: (name: string, version: string) => Promise<string | undefined>;
    readonly stage: (source: string, dataDirectory: string) => Promise<{ readonly digest: string }>;
    /** The content digest of a frozen package directory, as the Project's lock records it. */
    readonly digest: (packageDirectory: string) => Promise<string>;
  };
  /** Options the operator set for this recipe's runtime. */
  readonly options: Readonly<Record<string, unknown>>;
}

export type ZelavisRecipeRuntimeFactory = (
  context: ZelavisRecipeRuntimeContext,
) => ZelavisProjectRuntimeDriver;

/** Effect implementations behind the Promise-based Project runtime protocol. */
export { IntegrationFailure, unwrapFailure, type TaggedFailure, evaluate, integration, presentOperations, type EffectOperations } from "../core/runtime/effect-boundary.js";

import { presentOperations, type EffectOperations } from "../core/runtime/effect-boundary.js";

/** Native Effect implementation of the existing Project runtime driver protocol. */
export type ZelavisEffectProjectRuntimeDriver = EffectOperations<ZelavisProjectRuntimeDriver>;

/** Keep runtime effects native inside the Platform and expose Promises at the driver API boundary. */
export function defineEffectProjectRuntime(driver: ZelavisEffectProjectRuntimeDriver): ZelavisProjectRuntimeDriver {
  const { adopt, detach, commitUpgrade, abandonUpgrade, prepare, start, stop, status, logs, destroy, close, signGatewayAuthority, fencePrevious, prepareUpdate, applyUpdate, recoverUpdate, settleUpdate, versions, resolveVersion, gatewayTarget, ...metadata } = driver;
  return Object.assign(presentOperations({ adopt, detach, commitUpgrade, abandonUpgrade, prepare, start, stop, status, logs, destroy, close, signGatewayAuthority, fencePrevious, prepareUpdate, applyUpdate, recoverUpdate, settleUpdate, versions, resolveVersion, gatewayTarget }), metadata);
}
