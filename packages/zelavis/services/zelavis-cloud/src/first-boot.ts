/**
 * First-boot data for a machine Zelavis provisions as a worker.
 *
 * `user_data` is not secret: anyone with the cloud account can read it back and every
 * process on the machine can read it from the metadata service. It therefore carries
 * only what is public or worthless after first use: the Platform's address, the SHA-256
 * fingerprint of its TLS key, the node id and a single-use, short-lived enrollment token.
 * Nothing durable, and nothing from this process's own secrets (provider tokens).
 *
 * The script runs the same two steps an operator would: the published installer with
 * `--role worker`, then `zelavis worker join` as the worker's own account, so the Agent's
 * private key is created on the machine and never leaves it. The Platform is
 * authenticated by the pinned fingerprint, not by a certificate authority, because a
 * Platform may be reached by IP address.
 *
 * Authority and bounds: pure string construction. Every value is validated against a
 * strict character set before it is quoted, so no input can add a shell command.
 */

import { CapacityError } from "./capacity-error.js";

export const DEFAULT_INSTALLER_URL = "https://zelavis.com/install.sh";
export const WORKER_DATA_DIRECTORY = "/var/lib/zelavis-worker";
const WORKER_COMMAND = "/usr/local/bin/zelavis";
const WORKER_ACCOUNT = "zelavis-worker";

const MAX_URL = 2048;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;
const FINGERPRINT = /^(?:sha256:)?([A-Fa-f0-9]{2}(?::?[A-Fa-f0-9]{2}){31})$/;

export interface WorkerFirstBootInput {
  /** The Platform's https address, with its dashboard root path when it has one. */
  readonly platformUrl: string;
  /** SHA-256 of the Platform's TLS public key; the worker pins this. */
  readonly platformFingerprint: string;
  readonly nodeId: string;
  /** Single use and short lived; the Platform refuses it after the first enrollment. */
  readonly enrollmentToken: string;
  /** Overrides the published installer; https only. */
  readonly installerUrl?: string;
}

const invalid = (message: string) => new CapacityError("invalid-request", message);

function httpsUrl(value: string, label: string): string {
  if (value.length > MAX_URL) throw invalid(`${label} is too long.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new CapacityError("invalid-request", `${label} must be an absolute URL.`, cause);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw invalid(`${label} must be an https URL without credentials, query or fragment.`);
  }
  // A URL's own serialization is the quoted value; only characters that cannot end a quote survive.
  if (!/^[A-Za-z0-9:/._~%@!$&()*+,;=-]+$/.test(url.href) || url.href.includes("'")) {
    throw invalid(`${label} contains characters that are not allowed here.`);
  }
  return url.href;
}

/** The first-boot script, ready to hand to the cloud as `user_data`. */
export function workerFirstBootScript(input: WorkerFirstBootInput): string {
  const platformUrl = httpsUrl(input.platformUrl, "The Platform URL");
  const installerUrl = httpsUrl(input.installerUrl ?? DEFAULT_INSTALLER_URL, "The installer URL");
  const fingerprint = FINGERPRINT.exec(input.platformFingerprint.trim());
  if (!fingerprint) throw invalid("The Platform fingerprint must be a SHA-256 of 64 hex digits.");
  if (!NODE_ID.test(input.nodeId)) throw invalid("The node id has characters that are not allowed.");
  if (!TOKEN.test(input.enrollmentToken)) throw invalid("The enrollment token has an unexpected shape.");
  const pin = `sha256:${fingerprint[1]!.replaceAll(":", "").toLowerCase()}`;

  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    `curl --proto '=https' --tlsv1.2 -fsSL '${installerUrl}' | sh -s -- --role worker`,
    `runuser -u ${WORKER_ACCOUNT} -- ${WORKER_COMMAND} worker join --data-dir '${WORKER_DATA_DIRECTORY}' \\`,
    `  --platform-url '${platformUrl}' --platform-fingerprint '${pin}' \\`,
    `  --node-id '${input.nodeId}' --enrollment-token '${input.enrollmentToken}'`,
    "",
  ].join("\n");
}

/**
 * The `userData` option of the capacity provider: mints one enrollment token per machine
 * from the Platform and builds that machine's script. Minting is the caller's, because
 * only the Platform may issue a credential.
 */
export function workerFirstBoot(options: {
  readonly platformUrl: string;
  readonly platformFingerprint: string;
  readonly installerUrl?: string;
  readonly mintEnrollmentToken: (nodeId: string) => string | Promise<string>;
}): (context: { readonly nodeId: string }) => Promise<string> {
  return async ({ nodeId }) => workerFirstBootScript({
    platformUrl: options.platformUrl,
    platformFingerprint: options.platformFingerprint,
    nodeId,
    enrollmentToken: await options.mintEnrollmentToken(nodeId),
    ...(options.installerUrl === undefined ? {} : { installerUrl: options.installerUrl }),
  });
}
