/** Qualify the installed root broker and an unprivileged Platform on disposable Debian/systemd. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== "1") throw new Error("Run through wordpress-provisioning-container.sh on a disposable container.");
await access("/.dockerenv");
const platform = process.env.ZELAVIS_QUALIFICATION_PLATFORM ?? "/opt/zelavis/current/platform";
const phase = process.argv[2] ?? "create";
const baseUrl = "http://127.0.0.1:3000";
const { createZelavisClient } = await import(pathToFileURL(`${platform}/dist/sdk/fetch.js`).href);
if (phase === "claim") {
  assert.equal(process.getuid(), 0);
  const environment = await readFile("/etc/zelavis/zelavis.env", "utf8");
  const bootstrapToken = /^ZELAVIS_BOOTSTRAP_TOKEN=(.+)$/m.exec(environment)?.[1];
  const response = await fetch(`${baseUrl}/zelavis/api/v1/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ bootstrapToken, provider: "password", account: { email: "qualification@example.test" }, credential: { identifier: "qualification@example.test", password: "disposable qualification password 2026" } }),
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { writeFile } = await import("node:fs/promises");
  await writeFile("/var/lib/zelavis/qualification-session", cookie, { mode: 0o600 });
  console.log("PASS: installed Platform owner claimed through bootstrap.");
} else {
  assert.notEqual(process.getuid(), 0, "the qualification client and Project must be unprivileged");
  assert.equal(execFileSync("systemctl", ["show", "zelavis.service", "-p", "User", "--value"], { encoding: "utf8" }).trim(), "zelavis");
  const cookie = await readFile("/var/lib/zelavis/qualification-session", "utf8");
  const client = createZelavisClient({ baseUrl, headers: { cookie, origin: baseUrl } });
  if (phase === "cancel") {
    await assert.rejects(access("/usr/sbin/nginx"), { code: "ENOENT" });
    const operation = await client.hostOperations.submit({ operation: "zelavis.packages-install", version: "v1", arguments: { set: "wordpress-stack" }, deadlineMs: 1000 });
    let record = operation;
    for (let i = 0; i < 100 && ["running", "queued"].includes(record.agent?.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      record = await client.hostOperations.get(operation.operationId);
    }
    assert.equal(record.agent.status, "failed");
    const wrapper = await readFile("/usr/sbin/policy-rc.d", "utf8");
    assert.match(wrapper, /Zelavis host-package policy/);
    const normal = execFileSync("sh", ["-c", '/usr/sbin/policy-rc.d nginx start >/dev/null 2>&1; printf "%s" "$?"'], { encoding: "utf8" });
    const original = execFileSync("sh", ["-c", 'if [ -x /usr/sbin/policy-rc.d.zelavis-original ]; then /usr/sbin/policy-rc.d.zelavis-original nginx start >/dev/null 2>&1; printf "%s" "$?"; else printf 0; fi'], { encoding: "utf8" });
    assert.equal(normal, original, "cancelled APT must not leave a global deny policy");
    console.log("PASS: cancelled package operation preserves normal host service policy.");
  } else {
    const { createAgentProcessClient } = await import(pathToFileURL(`${platform}/dist/adapters/_agent-ipc.js`).href);
    const rootAgent = await createAgentProcessClient({ directory: "/opt/zelavis/host-agent/agent" });
    await assert.rejects(rootAgent.start({ workloadId: "forbidden", executable: "/bin/touch", args: ["/root/forbidden-project-command"] }), /host operations only/);
    await rootAgent.close();
    await assert.rejects(access("/opt/zelavis/host-agent/agent-operations/operations.sqlite"), { code: "EACCES" });
    const recipes = await client.projects.recipes();
    assert.deepEqual(recipes.find((recipe) => recipe.name === "@zelavis/wordpress").hostPackages, ["wordpress-stack"]);
    const project = await client.projects.create({ id: "qualification-wordpress", name: "Qualification WordPress", recipeName: "@zelavis/wordpress", installHostPackages: true });
    assert.equal(project.runtime.status, "running", JSON.stringify(project));
    const response = await fetch(project.runtime.url, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), /install.php/);
    console.log(`PASS: unprivileged WordPress Project answers ${response.status} with the installer redirect.`);
    for (const unit of ["nginx.service", "php8.2-fpm.service", "mariadb.service"]) {
      assert.notEqual(execFileSync("sh", ["-c", 'systemctl is-active "$1" 2>/dev/null || true', "sh", unit], { encoding: "utf8" }).trim(), "active", `${unit} must not occupy host ports`);
    }
    const repeated = await client.hostOperations.submit({ operation: "zelavis.packages-install", version: "v1", arguments: { set: "wordpress-stack" } });
    let record = repeated;
    for (let i = 0; i < 100 && record.agent?.status !== "succeeded"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      record = await client.hostOperations.get(repeated.operationId);
    }
    assert.equal(record.agent.status, "succeeded");
    assert.equal(record.agent.result.changed, false);
    await client.projects.remove(project.id);
    console.log("PASS: package installation is idempotent and Project deletion completes.");
  }
}
