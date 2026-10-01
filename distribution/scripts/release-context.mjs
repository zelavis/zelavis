import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exactVersion } from "./published-package.mjs";

export function releaseContext(ref, packageVersion, secrets = {}) {
  if (!exactVersion.test(packageVersion)) throw new Error("Invalid Platform package version.");
  const tagged = ref.startsWith("refs/tags/");
  if (tagged && ref !== `refs/tags/zelavis@${packageVersion}`) throw new Error("Release tag must match the checked-out Platform package version.");
  if (tagged) {
    for (const name of ["OPERATION_KEY", "OPERATION_KEY_ID", "APT_KEY", "APT_KEY_ID"]) {
      if (!secrets[name]) throw new Error(`Release signing is not configured: ${name}. Ask the release owner; unsigned tag builds are refused.`);
    }
  }
  const prerelease = packageVersion.includes("-");
  if (prerelease && !/^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/.test(packageVersion)) throw new Error("Only explicit alpha or stable release versions are supported.");
  return { version: packageVersion, prerelease, tagged };
}

export async function assertUnpublishedRelease(repository, tag, token, request = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token) throw new Error("GitHub release identity/authentication is required.");
  const response = await request(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Could not check existing release: HTTP ${response.status}.`);
  if ((await response.json()).draft !== true) throw new Error("This release is already public. Its versioned artifacts are immutable; publish a new version instead.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required for workflow preparation.");
  const manifest = JSON.parse(await readFile(new URL("../../packages/zelavis/package.json", import.meta.url), "utf8"));
  const context = releaseContext(process.env.GITHUB_REF ?? "", manifest.version, process.env);
  if (context.tagged) await assertUnpublishedRelease(process.env.GITHUB_REPOSITORY, `zelavis@${context.version}`, process.env.GH_TOKEN);
  await appendFile(process.env.GITHUB_OUTPUT, `version=${context.version}\nprerelease=${context.prerelease}\n`);
}
