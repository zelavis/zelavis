import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { resolveRuntimeApiBase } from "./services.js";

/** `GET /auth/bootstrap`: whether the first owner is still to be created, and how. */
export interface BootstrapStatus {
  required: boolean;
  available: boolean;
  tokenRequired: boolean;
  methods: readonly string[];
}

/** The first owner signs in with a username and password; an email, when given, is verified once email is configured. */
export interface BootstrapOwnerInput {
  bootstrapToken: string;
  username: string;
  password: string;
  displayName?: string;
  email?: string;
}

export interface BootstrapOwnerResult {
  status: string;
  userId: string;
  account: {
    id: string;
    username?: string;
    displayName?: string;
    roles?: readonly string[];
  };
  /** The owner's first session; never printed. */
  tokens: { accessToken: string; refreshToken: string };
  emailVerification?: { status: string };
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
  if (!input.username) {
    throw new Error("Platform owner bootstrap requires --username.");
  }
  if (!input.password) {
    throw new Error("Platform owner bootstrap requires a password.");
  }

  const url = `${resolveRuntimeApiBase(options.url)}/auth/bootstrap`;
  const fetcher = options.fetch ?? fetch;
  const response = (yield* integrationValue(fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // No Origin header: the answer carries the tokens, which this command deliberately never prints.
    body: JSON.stringify({
      bootstrapToken: input.bootstrapToken,
      username: input.username,
      password: input.password,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.email ? { email: input.email } : {}),
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
    `Owner sign-in: ${status.methods.length ? status.methods.join(", ") : "none"}`,
  ];
  return lines.join("\n");
}
