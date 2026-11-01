import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { resolveRuntimeApiBase } from "./services.js";

export interface BootstrapStatus {
  required: boolean;
  available: boolean;
  tokenRequired: boolean;
  providers: readonly string[];
  enrollmentProviders: readonly string[];
}

export interface BootstrapOwnerInput {
  bootstrapToken: string;
  provider: string;
  email?: string;
  username?: string;
  displayName?: string;
  password: string;
}

export interface BootstrapOwnerResult {
  account: {
    id: string;
    email?: string;
    username?: string;
    displayName?: string;
    roles?: readonly string[];
  };
  session: { token: string };
}

export interface BootstrapClientOptions {
  url?: string;
  fetch?: typeof fetch;
}

function readJson<TBody>(response: Response, url: string): Promise<TBody> {
    return present(Effect.gen(function* (): Effect.fn.Return<TBody, IntegrationFailure> {
  const text = (yield* integrationValue(response.text()));
  const body = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed with status ${response.status}.`;
    throw new Error(`${message} (${url})`);
  }

  return body as TBody;
}));
  }

export function readBootstrapStatus(
  options: BootstrapClientOptions = {},
): Promise<BootstrapStatus> {
    return present(Effect.gen(function* (): Effect.fn.Return<BootstrapStatus, IntegrationFailure> {
  const url = `${resolveRuntimeApiBase(options.url)}/auth/bootstrap`;
  const fetcher = options.fetch ?? fetch;
  return (yield* integrationValue(readJson<BootstrapStatus>((yield* integrationValue(fetcher(url))), url)));
}));
  }

export function bootstrapPlatformOwner(
  input: BootstrapOwnerInput,
  options: BootstrapClientOptions = {},
): Promise<BootstrapOwnerResult> {
    return present(Effect.gen(function* (): Effect.fn.Return<BootstrapOwnerResult, IntegrationFailure> {
  if (!input.email && !input.username) {
    throw new Error("Platform owner bootstrap requires --email or --username.");
  }
  if (!input.password) {
    throw new Error("Platform owner bootstrap requires a password.");
  }

  const url = `${resolveRuntimeApiBase(options.url)}/auth/bootstrap`;
  const fetcher = options.fetch ?? fetch;
  const identifier = input.email ?? input.username!;
  const response = (yield* integrationValue(fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: input.bootstrapToken,
      provider: input.provider,
      account: {
        ...(input.email ? { email: input.email } : {}),
        ...(input.username ? { username: input.username } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
      credential: { identifier, password: input.password },
    }),
  })));

  return (yield* integrationValue(readJson<BootstrapOwnerResult>(response, url)));
}));
  }

export function formatBootstrapStatus(status: BootstrapStatus): string {
  const lines = [
    status.required
      ? "This Platform has no owner yet."
      : "This Platform already has an owner; bootstrap is complete.",
    status.available
      ? "Bootstrap token: configured"
      : "Bootstrap token: not configured (set ZELAVIS_BOOTSTRAP_TOKEN and restart)",
    `Enrollment providers: ${
      status.enrollmentProviders.length
        ? status.enrollmentProviders.join(", ")
        : "none installed"
    }`,
  ];
  return lines.join("\n");
}
