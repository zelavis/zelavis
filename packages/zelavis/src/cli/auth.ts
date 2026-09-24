import { createZelavisClient, type ZelavisAuthAccount } from "../sdk/fetch.js";

const usage =
  "zelavis auth service-accounts <list|create|rotate|revoke> [account-id] [--name NAME] [--permission PERMISSION] [--project PROJECT_ID] [--expires-days DAYS] [--url URL] [--token TOKEN] [--json]";

/**
 * Platform machine identities through the same typed client applications use.
 * A Project shortcut grants the narrow Project operator permissions needed by
 * deployment clients without turning the identity into a Platform owner.
 */
export async function runAuthCommand(args: readonly string[]): Promise<void> {
  const positional: string[] = [];
  const permissions: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let name: string | undefined;
  let projectId: string | undefined;
  let expiresInDays: number | undefined;
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
    if (!["--url", "--token", "--name", "--permission", "--project", "--expires-days"].includes(flag)) {
      throw new Error(`Unknown auth option "${arg}".`);
    }
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--name") name = value;
    if (flag === "--permission") permissions.push(value);
    if (flag === "--project") projectId = value;
    if (flag === "--expires-days") {
      expiresInDays = Number(value);
      if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) {
        throw new Error("--expires-days requires an integer between 1 and 3650.");
      }
    }
  }

  const [resource, action, accountId, ...rest] = positional;
  if (resource !== "service-accounts" || !action) {
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
  const line = (account: ZelavisAuthAccount) =>
    `${account.id}\t${account.displayName ?? account.username ?? account.email ?? "service"}\t${account.permissions?.join(",") ?? ""}`;

  switch (action) {
    case "list": {
      const serviceAccounts = await client.auth.admin.serviceAccounts();
      print({ serviceAccounts }, () => serviceAccounts.map(line).join("\n") || "No service accounts.");
      return;
    }
    case "create": {
      if (!name?.trim()) throw new Error("auth service-accounts create requires --name.");
      const result = await client.auth.admin.createServiceAccount({
        name: name.trim(),
        permissions,
        ...(projectId
          ? {
              grants: [
                "project.view",
                "project.runtime.manage",
                "project.settings.manage",
                "project.users.manage",
              ].map((permission) => ({
                permission,
                scope: { type: "project" as const, projectId },
              })),
            }
          : {}),
        ...(expiresInDays === undefined ? {} : { expiresInDays }),
      });
      print(result, () => [
        `Created ${line(result.serviceAccount)}`,
        "Token (shown once):",
        result.token,
      ].join("\n"));
      return;
    }
    case "rotate": {
      if (!accountId) throw new Error("auth service-accounts rotate requires an account id.");
      const result = await client.auth.admin.rotateServiceAccountToken(accountId, expiresInDays);
      print(result, () => ["Rotated token (shown once):", result.token].join("\n"));
      return;
    }
    case "revoke": {
      if (!accountId) throw new Error("auth service-accounts revoke requires an account id.");
      await client.auth.admin.revokeServiceAccount(accountId);
      print({ revoked: accountId }, () => `Revoked ${accountId}.`);
      return;
    }
    default:
      throw new Error(`Unknown auth service-accounts command "${action}". ${usage}`);
  }
}
