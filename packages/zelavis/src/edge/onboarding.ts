import { lookup } from "node:dns/promises";
import type { ZelavisEdgeRouteStore, ZelavisEdgeHostname } from "./routes.js";
import { toPublicationSummary } from "./routes.js";
import type { ZelavisEdgeManager, ZelavisEdgePublication } from "./index.js";

export type ZelavisEdgeOnboardingMode = "managed" | "external" | "later";

export interface ZelavisEdgeOnboardingRequest {
  mode: ZelavisEdgeOnboardingMode;
  /** Required when mode is "managed" or "external". Fully qualified domain name. */
  hostname?: string;
  /** Optional local platform target URL. Defaults to "http://127.0.0.1:3000". */
  localTargetUrl?: string;
}

export interface ZelavisEdgeOnboardingPreflightResult {
  hostname: string;
  valid: boolean;
  dnsResolved: boolean;
  addresses?: readonly string[];
  error?: string;
}

export interface ZelavisEdgeOnboardingResult {
  mode: ZelavisEdgeOnboardingMode;
  status: "configured" | "deferred" | "failed";
  hostname?: string;
  canonicalUrl?: string;
  publication?: ZelavisEdgePublication;
  error?: string;
}

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Validate hostname format and check DNS resolution before onboarding.
 */
export async function preflightHostname(
  rawHostname: string,
): Promise<ZelavisEdgeOnboardingPreflightResult> {
  const hostname = rawHostname.trim().toLowerCase().replace(/\.+$/, "");

  if (!hostname || !HOSTNAME_PATTERN.test(hostname)) {
    return {
      hostname,
      valid: false,
      dnsResolved: false,
      error: `"${hostname}" is not a valid fully qualified domain name.`,
    };
  }

  // Check DNS resolution
  try {
    const results = await lookup(hostname, { all: true });
    const addresses = results.map((r) => r.address);
    return {
      hostname,
      valid: true,
      dnsResolved: addresses.length > 0,
      addresses,
    };
  } catch (error) {
    return {
      hostname,
      valid: true,
      dnsResolved: false,
      error: `DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

import type { ZelavisCertificateController } from "./certificates.js";

export interface PerformOnboardingContext {
  routeStore: ZelavisEdgeRouteStore;
  edgeManager?: ZelavisEdgeManager;
  certificateController?: ZelavisCertificateController;
}

/**
 * Performs hostname onboarding for Zelavis Edge.
 *
 * Safe and idempotent:
 * - "later": Leaves public routing deferred.
 * - "external": Configures external TLS hostname + Platform root route.
 * - "managed": Configures managed TLS hostname + Platform root route and switches Edge.
 */
export async function performEdgeOnboarding(
  context: PerformOnboardingContext,
  request: ZelavisEdgeOnboardingRequest,
): Promise<ZelavisEdgeOnboardingResult> {
  const { routeStore, edgeManager } = context;
  const localTargetUrl = request.localTargetUrl ?? "http://127.0.0.1:3000";

  if (request.mode === "later") {
    return {
      mode: "later",
      status: "deferred",
    };
  }

  if (!request.hostname) {
    return {
      mode: request.mode,
      status: "failed",
      error: "Hostname is required for managed or external onboarding.",
    };
  }

  const hostname = request.hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return {
      mode: request.mode,
      status: "failed",
      error: `"${hostname}" is not a valid fully qualified domain name.`,
    };
  }

  const tlsMode = request.mode === "managed" ? "managed" : "external";
  const certificateRef = tlsMode === "managed" ? `certificate:${hostname}` : undefined;

  const hostnameEntry: ZelavisEdgeHostname = {
    host: hostname,
    scope: "platform",
    tlsMode,
    ...(certificateRef ? { certificateRef } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 1. Put Hostname
  await routeStore.putHostname(hostnameEntry);

  // 2. Issue or verify certificate if certificate controller is provided
  if (tlsMode === "managed" && context.certificateController) {
    try {
      await context.certificateController.orderCertificate({
        hostname,
      });
    } catch (certError) {
      return {
        mode: request.mode,
        status: "failed",
        hostname,
        error: `Certificate issuance failed: ${certError instanceof Error ? certError.message : String(certError)}`,
      };
    }
  }

  // 3. Put Platform Root Route
  await routeStore.putRoute({
    id: "platform:root",
    scope: "platform",
    hostname,
    pathPrefix: "/",
    pathMatch: "prefix",
    targets: [{ url: localTargetUrl, weight: 100 }],
    protocols: ["http", "websocket", "sse"],
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // 3. Compile publication
  const compiled = await routeStore.compile();
  const pubSummary = toPublicationSummary(compiled);

  // 4. Switch edge adapter if Edge manager is active
  if (edgeManager) {
    try {
      await edgeManager.switchAdapter("traefik", pubSummary);
    } catch (switchError) {
      return {
        mode: request.mode,
        status: "failed",
        hostname,
        publication: pubSummary,
        error: `Edge switch failed: ${switchError instanceof Error ? switchError.message : String(switchError)}`,
      };
    }
  }

  return {
    mode: request.mode,
    status: "configured",
    hostname,
    canonicalUrl: `https://${hostname}`,
    publication: pubSummary,
  };
}
