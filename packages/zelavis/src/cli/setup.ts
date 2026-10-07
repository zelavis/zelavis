import * as prompts from "@clack/prompts";
import { Effect } from "effect";
import { IntegrationFailure, evaluate, integration, present, unwrapFailure } from "../core/runtime/effect-boundary.js";
import colors from "picocolors";

import {
  bootstrapPlatformOwner,
  readBootstrapStatus,
  type BootstrapClientOptions,
} from "./bootstrap.js";
import { createZelavisClient } from "../sdk/fetch.js";

export interface SetupWizardOptions extends BootstrapClientOptions {
  bootstrapToken?: string;
}

function required(value: string | undefined, label: string) {
  if (!value?.trim()) return `${label} is required.`;
}

function cancelled(value: unknown): value is symbol {
  if (!prompts.isCancel(value)) return false;
  prompts.cancel("Setup cancelled. No changes were made.");
  return true;
}

function dashboardUrl(url?: string) {
  const raw = url ?? "http://127.0.0.1:3000/zelavis";
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/api\/v1\/?$/u, "").replace(/\/$/u, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return raw;
  }
}

const messageOf = (failure: IntegrationFailure): string => {
  const error = unwrapFailure(failure);
  return error instanceof Error ? error.message : String(error);
};

export function runSetupWizard(
  options: SetupWizardOptions = {},
): Promise<void> {
  return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return yield* Effect.fail(new IntegrationFailure(new Error(
      "zelavis setup is interactive and requires a terminal. For automation, use zelavis bootstrap with --email or --username and --password-stdin.",
    )));
  }

  prompts.intro(colors.cyan(colors.bold("◉ Zelavis setup")));
  const statusSpinner = prompts.spinner();
  statusSpinner.start("Connecting to the Platform");

  const status = yield* integration(() => readBootstrapStatus(options)).pipe(
    Effect.tap(() => Effect.sync(() => statusSpinner.stop("Platform is online"))),
    Effect.tapError(() => Effect.sync(() => statusSpinner.error("Could not reach the Platform"))),
  );

  if (!status.required) {
    prompts.note(dashboardUrl(options.url), "Dashboard");
    prompts.outro(colors.green("✓ This Platform is already configured."));
    return;
  }
  if (!status.available) {
    prompts.note(
      "Set ZELAVIS_BOOTSTRAP_TOKEN to a random value of at least 32 characters, restart Zelavis, then run this wizard again.",
      "Bootstrap token missing",
    );
    prompts.outro(colors.yellow("Setup is waiting for secure bootstrap configuration."));
    return;
  }
  if (status.enrollmentProviders.length === 0) {
    prompts.note(
      "Install a credential-enrollment auth provider and restart Zelavis before creating the first owner.",
      "No enrollment provider",
    );
    prompts.outro(colors.yellow("Setup cannot continue yet."));
    return;
  }

  prompts.note(
    `${colors.dim("Platform")}  ${dashboardUrl(options.url)}\n${colors.dim("Purpose")}   Create the first Platform owner`,
    "First-run setup",
  );

  const provider = status.enrollmentProviders.length === 1
    ? status.enrollmentProviders[0]!
    : yield* integration(() => prompts.select({
        message: "Choose the owner credential provider",
        options: status.enrollmentProviders.map((value) => ({ value, label: value })),
      }));
  if (cancelled(provider)) return;

  const acceptsUsername = provider === "password";
  const identifier = yield* integration(() => prompts.text({
    message: acceptsUsername ? "Owner email or username" : "Owner email",
    placeholder: "owner@example.com",
    validate: (value) => required(value, acceptsUsername ? "An email or username" : "An email"),
  }));
  if (cancelled(identifier)) return;

  const displayName = yield* integration(() => prompts.text({
    message: "Display name",
    placeholder: "Platform Owner (optional)",
  }));
  if (cancelled(displayName)) return;

  const password = yield* integration(() => prompts.password({
    message: "Owner password",
    validate: (value) =>
      !value || value.length < 15 ? "Use at least 15 characters." : undefined,
  }));
  if (cancelled(password)) return;
  const passwordConfirmation = yield* integration(() => prompts.password({
    message: "Confirm owner password",
    validate: (value) => value !== password ? "The passwords do not match." : undefined,
  }));
  if (cancelled(passwordConfirmation)) return;

  let bootstrapToken = options.bootstrapToken ?? process.env.ZELAVIS_BOOTSTRAP_TOKEN;
  if (!bootstrapToken) {
    const enteredToken = yield* integration(() => prompts.password({
      message: "One-time bootstrap token",
      validate: (value) => !value || value.length < 32 ? "The token must contain at least 32 characters." : undefined,
    }));
    if (cancelled(enteredToken)) return;
    bootstrapToken = enteredToken;
  }

  const confirmed = yield* integration(() => prompts.confirm({
    message: `Create ${String(identifier)} as the Platform owner?`,
    initialValue: true,
  }));
  if (cancelled(confirmed)) return;
  if (!confirmed) {
    prompts.cancel("Setup cancelled. No changes were made.");
    return;
  }

  const createSpinner = prompts.spinner();
  createSpinner.start("Creating the Platform owner");
  const ownerToken = bootstrapToken;
  yield* Effect.gen(function* () {
    const identity = String(identifier).trim();
    const result = yield* integration(() => bootstrapPlatformOwner(
      {
        bootstrapToken: ownerToken,
        provider: String(provider),
        ...(acceptsUsername && !identity.includes("@")
          ? { username: identity }
          : { email: identity }),
        ...(String(displayName).trim() ? { displayName: String(displayName).trim() } : {}),
        password: String(password),
      },
      options,
    ));
    createSpinner.stop("Platform owner created");

    const edgeSpinner = prompts.spinner();
    edgeSpinner.start("Checking Zelavis Edge");
    let edgeClient: ReturnType<typeof createZelavisClient>["edge"] | undefined;
    yield* Effect.gen(function* () {
      const client = yield* evaluate(() => {
        const root = new URL(dashboardUrl(options.url));
        return createZelavisClient({
          baseUrl: root.origin,
          rootPath: root.pathname,
          headers: { authorization: `Bearer ${result.session.token}` },
        });
      });
      edgeClient = client.edge;
      const edge = yield* integration(() => client.edge.status());
      const ready = edge.adapters.filter(
        (adapter) => adapter.detection.state === "available",
      );
      edgeSpinner.stop(
        edge.policy.activeAdapterId
          ? `Edge is active on ${edge.policy.activeAdapterId}`
          : ready.length > 0
            ? `Edge found ${ready.map((adapter) => adapter.id).join(", ")}`
            : "No ready Edge adapter found",
      );
    }).pipe(Effect.catch((failure) => Effect.sync(() => {
      edgeSpinner.stop("Edge host integration is not ready yet");
      prompts.note(
        `${messageOf(failure)}\nThe Platform stays on its private listener; no unverified proxy was made live.`,
        "Reverse proxy",
      );
    })));

    if (edgeClient) {
      const edge = edgeClient;
      const mode = yield* integration(() => prompts.select({
        message: "Platform hostname & TLS ingress",
        options: [
          { value: "managed", label: "Zelavis-managed HTTPS (recommended)", hint: "verify DNS and enable automated TLS" },
          { value: "external", label: "External TLS", hint: "operator proxy or load balancer terminates TLS" },
          { value: "later", label: "Configure later", hint: "keep private listener, configure Edge later" },
        ],
        initialValue: "later",
      }));

      if (!prompts.isCancel(mode) && (mode === "managed" || mode === "external")) {
        const hostnameInput = yield* integration(() => prompts.text({
          message: "Platform Hostname (FQDN)",
          placeholder: "panel.example.com",
          validate: (val) => {
            const trimmed = String(val ?? "").trim().toLowerCase().replace(/\.+$/, "");
            if (!trimmed) return "Hostname is required";
            if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(trimmed)) {
              return "Must be a valid fully qualified domain name (e.g. panel.example.com)";
            }
          },
        }));

        if (!prompts.isCancel(hostnameInput) && String(hostnameInput).trim()) {
          const onboardSpinner = prompts.spinner();
          onboardSpinner.start("Configuring Platform ingress");
          yield* integration(() => edge.onboardHostname({
            mode,
            hostname: String(hostnameInput).trim(),
          })).pipe(
            Effect.tap((onboardResult) => Effect.sync(() => {
              if (onboardResult.status === "configured") {
                onboardSpinner.stop(`Ingress configured: ${onboardResult.canonicalUrl}`);
              } else {
                onboardSpinner.stop(`Onboarding: ${onboardResult.status}`);
                if (onboardResult.error) {
                  prompts.note(onboardResult.error, "Edge Notice");
                }
              }
            })),
            Effect.catch((failure) => Effect.sync(() => {
              onboardSpinner.stop("Edge onboarding deferred");
              prompts.note(messageOf(failure), "Edge Notice");
            })),
          );
        }
      }
    }
    prompts.note(
      `${result.account.displayName ?? result.account.email ?? result.account.username ?? result.account.id}\n${dashboardUrl(options.url)}`,
      "Ready",
    );
    prompts.outro(colors.green(colors.bold("✓ Zelavis is ready.")));
  }).pipe(Effect.onError(() => Effect.sync(() => createSpinner.error("Owner creation failed"))));
  }));
}
