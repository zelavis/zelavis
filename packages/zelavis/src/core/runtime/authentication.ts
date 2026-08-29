import type {
  ZelavisAccessResolveContext,
  ZelavisPrincipal,
  ZelavisPrincipalResolver,
} from "./contracts.js";

export interface ZelavisAuthenticationChallenge {
  scheme: string;
  parameters?: Readonly<Record<string, string>>;
}

export class ZelavisAuthenticationError extends Error {
  readonly challenge?: ZelavisAuthenticationChallenge;

  constructor(
    message = "Invalid authentication credentials.",
    options: { challenge?: ZelavisAuthenticationChallenge; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ZelavisAuthenticationError";
    this.challenge = options.challenge;
  }
}

export interface ZelavisRequestAuthenticator<TService = unknown> {
  readonly name: string;
  authenticate(
    context: ZelavisAccessResolveContext<TService>,
  ):
    | ZelavisPrincipal
    | undefined
    | Promise<ZelavisPrincipal | undefined>;
}

export function formatAuthenticationChallenge(
  challenge: ZelavisAuthenticationChallenge,
): string {
  const parameters = Object.entries(challenge.parameters ?? {}).map(
    ([name, value]) => `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return parameters.length
    ? `${challenge.scheme} ${parameters.join(", ")}`
    : challenge.scheme;
}

/**
 * Compose independent native-Web request authenticators into the principal
 * resolver consumed by the core dispatcher. Authenticators return undefined
 * when their credential form is absent and throw ZelavisAuthenticationError
 * when it is present but invalid.
 */
export function composeRequestAuthenticators<TService = unknown>(
  authenticators: readonly ZelavisRequestAuthenticator<TService>[],
): ZelavisPrincipalResolver<TService> {
  const frozen = Object.freeze([...authenticators]);
  return async (context) => {
    for (const authenticator of frozen) {
      const principal = await authenticator.authenticate(context);
      if (principal) return principal;
    }
    return undefined;
  };
}

export function readAuthorizationCredential(
  request: Request,
  scheme: string,
): string | undefined {
  const value = request.headers.get("authorization");
  if (!value) return undefined;

  const separator = value.indexOf(" ");
  if (separator < 1 || value.slice(0, separator).toLowerCase() !== scheme.toLowerCase()) {
    return undefined;
  }

  const credential = value.slice(separator + 1).trim();
  if (!credential || /\s/.test(credential)) {
    throw new ZelavisAuthenticationError(`Malformed ${scheme} credentials.`, {
      challenge: { scheme },
    });
  }
  return credential;
}
