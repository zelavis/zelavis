import { networkInterfaces } from "node:os";

/** The machine's first routable IPv4 address, or undefined when it has none. */
export function firstRoutableAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return undefined;
}
