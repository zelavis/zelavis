/**
 * Pure helpers for the node and cloud capacity panels.
 *
 * Kept free of React and fetch so the join command, the node name rule and the
 * provider list can be tested alone.
 */

/** Node ids are what `zelavis worker join --node-id` accepts: a short, lower-case label. */
export const NODE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Providers the bundled cloud service can drive today. */
export const CLOUD_PROVIDERS = [{ id: "hetzner", label: "Hetzner Cloud" }] as const;

export function isValidNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value);
}

/** The command an operator runs on the new machine, as root, after installing the worker role. */
export function joinCommand(input: {
  platform: { url: string; fingerprint: string };
  nodeId: string;
  token: string;
}): string {
  const fingerprint = input.platform.fingerprint.startsWith("sha256:")
    ? input.platform.fingerprint
    : `sha256:${input.platform.fingerprint}`;
  return [
    "zelavis worker join",
    `--platform-url ${input.platform.url.replace(/\/+$/, "")}/zelavis`,
    `--node-id ${input.nodeId}`,
    `--enrollment-token ${input.token}`,
    `--platform-fingerprint ${fingerprint}`,
  ].join(" ");
}

/** A fresh, unguessable-enough request id; the controller makes a request idempotent per id. */
export function newRequestId(random: () => string = () => crypto.randomUUID()): string {
  return `ui-${random().replaceAll("-", "").slice(0, 16)}`;
}
