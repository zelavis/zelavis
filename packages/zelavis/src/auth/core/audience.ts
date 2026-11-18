/**
 * A Project's Auth audience (Zelavis-own): the first 24 hex characters of the SHA-256 of its id. It names the
 * Project's cookies (`projectAuthCookieNames`) and its service tokens, and the public domain forwarder uses it to let
 * only the exact App's credentials through.
 */
import * as Effect from "effect/Effect";
import { sha256Hex } from "../lib/crypto.js";

export const projectAuthAudience = (projectId: string): Effect.Effect<string> =>
  Effect.map(sha256Hex(projectId), (hex) => hex.slice(0, 24));

/** The `iss` of a Project's access tokens. */
export const projectAuthIssuer = (projectId: string): string => `zelavis:project:${projectId}`;
