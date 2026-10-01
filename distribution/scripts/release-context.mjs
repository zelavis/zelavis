import { appendFile, readFile } from "node:fs/promises";
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

if (process.env.GITHUB_OUTPUT) {
  const manifest = JSON.parse(await readFile(new URL("../../packages/zelavis/package.json", import.meta.url), "utf8"));
  const context = releaseContext(process.env.GITHUB_REF ?? "", manifest.version, process.env);
  await appendFile(process.env.GITHUB_OUTPUT, `version=${context.version}\nprerelease=${context.prerelease}\n`);
}
