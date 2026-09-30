import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis marketplace <allowlist|refresh> [--url URL] [--token TOKEN] [--json]";

/**
 * `zelavis marketplace` — the allow-list routes through the JS SDK client.
 *
 * `allowlist` shows how current the list is; `refresh` fetches it again from
 * its sources and reports what each one answered.
 */
export async function runMarketplaceCommand(args: readonly string[]): Promise<void> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      return;
    }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token"].includes(flag)) {
      throw new Error(`Unknown marketplace option "${arg}".`);
    }
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
  }

  const [action, ...rest] = positional;
  if (!action) {
    console.log(usage);
    return;
  }
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const print = (value: unknown, text: () => string) =>
    console.log(json ? JSON.stringify(value, null, 2) : text());
  const describe = (list: Awaited<ReturnType<typeof client.marketplace.allowlist>>["list"]) =>
    list
      ? `sequence ${list.sequence}, ${list.status}, ${list.services} services, from the ${list.origin} (expires ${list.expiresAt})`
      : "No allow-list is held, so nothing can be installed from the marketplace.";

  switch (action) {
    case "allowlist": {
      const status = await client.marketplace.allowlist();
      print(status, () =>
        `${status.gated ? "Installs are limited to the allow-list" : "Installs are not limited to the allow-list"}; ${status.sources} source(s).\n${describe(status.list)}`);
      return;
    }
    case "refresh": {
      const result = await client.marketplace.refresh();
      print(result, () =>
        [
          result.updated ? "Updated." : "Nothing newer was found.",
          ...result.attempts.map((a) => `${a.source}: ${a.outcome}${a.detail ? ` (${a.detail})` : ""}`),
          describe(result.list),
        ].join("\n"));
      return;
    }
    default:
      throw new Error(`Unknown marketplace command "${action}". ${usage}`);
  }
}
