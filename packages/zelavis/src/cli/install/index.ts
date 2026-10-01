import { createNodeInstallHost, nodeInstallationPaths, assertNodeInstallationPrivilege } from "../../adapters/_install-host.js";
import { executeZelavisInstallationPlan, planZelavisReleaseInstall } from "../../core/runtime/installation-plan.js";

/** Host-local release entry. Package acquisition and user mode are later phases. */
export async function runReleaseInstall(args: readonly string[]): Promise<void> {
  let source: string | undefined;
  let dryRun = false, json = false, publicBind = false, allowDowngrade = false;
  let force = process.env.ZELAVIS_FORCE_BIN === "1";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from-release") {
      source = args[++i];
      if (!source || source.startsWith("--")) throw new Error("--from-release requires the absolute path of a staged release.");
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "--force") force = true;
    else if (arg === "--public") publicBind = true;
    else if (arg === "--allow-downgrade") allowDowngrade = true;
    else throw new Error(`Unknown install option: ${arg}`);
  }
  if (!source) throw new Error("zelavis install requires --from-release <absolute staged-release path>.");
  const host = createNodeInstallHost();
  const paths = nodeInstallationPaths();
  const system = process.getuid?.() === 0 && !!await host.which("systemctl");
  if (!dryRun && paths.prefix === "/opt/zelavis" && process.getuid?.() !== 0) {
    throw new Error("Run this installer as root, or set ZELAVIS_PREFIX and ZELAVIS_BIN_DIR.");
  }
  if (system && !dryRun) await assertNodeInstallationPrivilege(paths);
  const plan = await planZelavisReleaseInstall({ host, source, paths, system, force, public: publicBind, allowDowngrade, enableAgent: process.env.ZELAVIS_ENABLE_AGENT === "1" });
  if (dryRun) {
    console.log(json ? JSON.stringify(plan, null, 2) : ["Zelavis install plan", ...plan.steps.map((step) => `  ${step.id}: ${step.description} (idempotent: ${step.idempotent})`), ...plan.warnings, "No changes were made."].join("\n"));
    return;
  }
  for (const warning of plan.warnings) console.error(warning);
  const output = await executeZelavisInstallationPlan(host, plan);
  if (json) console.log(JSON.stringify({ installed: true, plan, output }, null, 2));
  else {
    console.log("Zelavis installed.\nDashboard: http://127.0.0.1:3000/zelavis");
    if (system && !publicBind) console.log("From your local machine: ssh -N -L 3000:127.0.0.1:3000 <user>@<server>");
    for (const line of output) console.log(line);
  }
}
