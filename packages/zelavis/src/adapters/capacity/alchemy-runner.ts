import { mkdirSync } from "node:fs";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import * as Interaction from "alchemy/Interaction";
import type { State } from "alchemy/State";
import { StackConfigOverrides } from "alchemy/Util/ConfigProvider";
import { PlatformServices } from "alchemy/Util/PlatformServices";

/**
 * Runs Alchemy headless, inside a long-lived process, with nothing it did not
 * need and nothing it was not told:
 *
 * - **No telemetry.** Alchemy's own entrypoints add a layer that exports
 *   traces, metrics and logs to a vendor collector, tagged with a persistent
 *   user id, the git root commit and hashed origin and branch, and host
 *   details. This runner never composes it, and also sets the vendor's
 *   documented opt-out so a future composition cannot enable it silently.
 * - **No ambient home directory.** Its profile, credential and telemetry id
 *   files live under `ALCHEMY_HOME`, which this points at `workDir`. Its
 *   working directory (logs, scratch) is `workDir` too, never the process cwd.
 * - **Credentials are configuration, not environment.** The token reaches
 *   Alchemy through an in-memory `ConfigProvider`, so it is not written to
 *   `process.env`, where every child process would inherit it.
 * - **Never interactive.** There is no prompt to answer in a server.
 *
 * `alchemy` is a beta dependency and this composition tracks its internals
 * (the same layers its own test helper assembles). Re-verify it, and the
 * network guard test, on every version bump.
 */
export interface AlchemyRunnerOptions {
  /** Provider credentials and settings, e.g. `HCLOUD_TOKEN`, `HCLOUD_ENDPOINT`. */
  readonly config: Readonly<Record<string, string>>;
  /** Alchemy's home and working directory. Created if missing. */
  readonly workDir: string;
}

export interface AlchemyRunInput {
  /** A stack program built with `Alchemy.Stack(...)`. */
  readonly stack: Effect.Effect<any, any, any>;
  readonly stage: string;
  /** The provisioning state for this stack and stage (see `createProvisioningState`). */
  readonly state: { readonly layer: Layer.Layer<State> };
}

export interface AlchemyRunner {
  readonly deploy: (input: AlchemyRunInput) => Effect.Effect<unknown, unknown>;
  readonly destroy: (input: AlchemyRunInput) => Effect.Effect<unknown, unknown>;
}

export function makeAlchemyRunner(options: AlchemyRunnerOptions): AlchemyRunner {
  const { config, workDir } = options;
  mkdirSync(workDir, { recursive: true });
  process.env.ALCHEMY_HOME = workDir;
  process.env.ALCHEMY_TELEMETRY_DISABLED = "1";

  const context = Layer.succeed(AlchemyContext, {
    dotAlchemy: workDir,
    dev: false,
    adopt: false,
    updateStateStore: false,
  });
  const platform = Layer.mergeAll(
    PlatformServices,
    FetchHttpClient.layer,
    Layer.provide(ProfileStoreLive, PlatformServices),
    Layer.provide(CredentialsStoreLive, PlatformServices),
  );
  const services = Layer.mergeAll(LoggingCli, Interaction.layerNonInteractive(), context);

  const provide = (effect: Effect.Effect<any, any, any>, input: AlchemyRunInput) =>
    (effect as Effect.Effect<unknown, unknown, never>).pipe(
      provideFreshArtifactStore,
      Effect.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...config }))),
      Effect.provideService(StackConfigOverrides, { profile: undefined }),
      Effect.provideService(AdoptPolicy, false),
      Effect.provide(input.state.layer),
      Effect.provideService(AuthProviders, {}),
      Effect.provide(Layer.provideMerge(services, platform)),
      Effect.scoped,
    ) as Effect.Effect<unknown, unknown>;

  return {
    deploy: (input) => provide(deploy({ stack: input.stack as never, stage: input.stage, dev: false }), input),
    destroy: (input) => provide(destroy({ stack: input.stack as never, stage: input.stage, dev: false }), input),
  };
}
