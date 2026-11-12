import { Effect } from "effect";
import { integration, present } from "../../../core/runtime/effect-boundary.js";

export function projectSessionAudience(projectId: string): Promise<string> {
  return present(Effect.gen(function* () {
    const digest = yield* integration(() => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(projectId)));
    return Array.from(new Uint8Array(digest, 0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }));
}

export const projectSessionCookieName = (audience: string): string => `zelavis_app_${audience}`;
export const projectSessionTokenPrefix = (audience: string): string => `zvs_app_${audience}_`;
