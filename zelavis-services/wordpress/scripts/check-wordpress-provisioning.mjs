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
  if (phase === "seed-upgrade") {
    // Controlled historical-lock fixture on a stopped disposable installation.
    // No live System Store is edited, and this is not a released recipe version.
    assert.notEqual(execFileSync("sh", ["-c", "systemctl is-active zelavis.service 2>/dev/null || true"], { encoding: "utf8" }).trim(), "active");
    const { writeFile } = await import("node:fs/promises");
    const { createLocalSqliteSystemStore } = await import(pathToFileURL(`${platform}/dist/adapters/_sqlite-system-store.js`).href);
    const { digestArtifactDirectory } = await import(pathToFileURL(`${platform}/dist/adapters/_recipe-artifact.js`).href);
    const id = "qualification-wordpress";
    const directory = `/var/lib/zelavis/projects/${id}`;
    const frozen = `${directory}/.zelavis/recipe/package`;
    const manifest = JSON.parse(await readFile(`${frozen}/package.json`, "utf8"));
    manifest.version = "0.0.0-qualification";
    manifest.zelavis.project.managed.adminTitle = "Historical integration admin";
    await writeFile(`${frozen}/package.json`, JSON.stringify(manifest));
    await writeFile(`${frozen}/dist/index.js`, `import { zelavis } from "zelavis/sdk";
export { WORDPRESS_APP_NAME } from "./runtime.js";
export function register() {
  zelavis.plugins.ui.menus.create({ title: "Historical SDK integration", path: "/historical-integration", surface: "root" });
  zelavis.operations.create({ id: "integration.get", resource: "integration", action: "get", method: "GET", path: "/integration",
    spec: { operationId: "getHistoricalIntegration", summary: "Read the historical integration fixture" }, handler: () => ({ status: 200, body: { revision: "historical" } }) });
}`);
    const descriptor = JSON.parse(await readFile(`${directory}/project.json`, "utf8"));
    descriptor.recipe = { ...descriptor.recipe, version: manifest.version, managed: manifest.zelavis.project.managed, artifact: { digest: await digestArtifactDirectory(frozen) } };
    await writeFile(`${directory}/project.json`, JSON.stringify(descriptor));
    const store = createLocalSqliteSystemStore({ filename: "/var/lib/zelavis/system/zelavis.sqlite" });
    try {
      const record = await store.get("projects", id);
      assert.equal(record.value.desiredState, "stopped");
      await store.set("projects", id, { ...record.value, recipe: descriptor.recipe });
    } finally { await store.close(); }
    console.log("PASS: stopped WordPress historical recipe lock fixture prepared.");
  } else if (phase === "cancel") {
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
    let project = ["verify-preview", "upgrade", "start-historical"].includes(phase) ? await client.projects.get("qualification-wordpress") : await client.projects.create({ id: "qualification-wordpress", name: "Qualification WordPress", recipeName: "@zelavis/wordpress", installHostPackages: true });
    if (phase === "start-historical") {
      assert.equal(project.recipeStatus.state, "upgradeAvailable");
      project = await client.projects.start(project.id);
      assert.equal(project.recipe.version, "0.0.0-qualification");
      console.log("PASS: historical integration fixture is running before the Platform update.");
    }
    if (phase === "upgrade") {
      assert.equal(project.recipeStatus.state, "upgradeAvailable");
      project = await client.projects.upgrade(project.id, {});
      assert.equal(project.recipe.version, recipes.find(recipe => recipe.name === "@zelavis/wordpress").version);
      assert.equal(project.runtime.status, "stopped");
      project = await client.projects.start(project.id);
      console.log("PASS: authenticated recipe upgrade freezes the current WordPress recipe and starts it.");
    }
    if (phase === "verify-preview") {
      for(let attempt=0; attempt<120 && project.runtime.status !== "running"; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,500));
        project=await client.projects.get(project.id);
      }
    }
    assert.equal(project.runtime.status, "running", JSON.stringify(project));
    const response = await fetch(project.runtime.url, { redirect: "manual" });
    if (phase === "create") {
      assert.equal(response.status, 302);
      assert.match(response.headers.get("location"), /install.php/);
    }
    assert.equal(project.preview.status, "ready", JSON.stringify(project.preview));
    const previewUrl = `http://127.0.0.1:${project.preview.port}`;
    const { writeFile } = await import("node:fs/promises");
    if (phase === "create") {
      const address = execFileSync("hostname",["-I"],{encoding:"utf8"}).trim().split(/\s+/)[0];
      const externalOrigin = `http://${address}:${project.preview.port}`;
      const external = await fetch(externalOrigin,{redirect:"manual"});
      assert.equal(external.status,302,"preview must listen on the server network interface");
      assert.equal(new URL(external.headers.get("location")).origin,externalOrigin);
      const installer = await fetch(previewUrl, {redirect:"manual"});
      assert.equal(installer.status,302);
      assert.equal(new URL(installer.headers.get("location")).origin,previewUrl);
      const install = await fetch(`${previewUrl}/wp-admin/install.php?step=2`, {
        method:"POST",body:new URLSearchParams({weblog_title:"Preview qualification",user_name:"preview_owner",admin_password:"Disposable Preview Password 2026!",admin_password2:"Disposable Preview Password 2026!",admin_email:"preview@example.test",blog_public:"0",pw_weak:"1",Submit:"Install WordPress"}),
      });
      assert.match(await install.text(),/Success!|WordPress has been installed/i);
      await writeFile("/var/lib/zelavis/qualification-preview",String(project.preview.port));

    } else {
      assert.equal(String(project.preview.port),await readFile("/var/lib/zelavis/qualification-preview","utf8"));
    }
    const loginPage = await fetch(`${previewUrl}/wp-login.php`);
    const testCookies = loginPage.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    const login = await fetch(`${previewUrl}/wp-login.php`, {
      method:"POST",redirect:"manual",headers:{cookie:testCookies},
      body:new URLSearchParams({log:"preview_owner",pwd:"Disposable Preview Password 2026!",testcookie:"1",redirect_to:`${previewUrl}/wp-admin/`}),
    });
    assert.equal(login.status,302);
    assert.equal(new URL(login.headers.get("location")).origin,previewUrl);
    const loginCookies=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    assert.match(loginCookies,/wordpress_logged_in_/);
    let admin=await fetch(`${previewUrl}/wp-admin/`,{headers:{cookie:loginCookies},redirect:"manual"});
    for(let hop=0; hop<5 && [301,302,303,307,308].includes(admin.status);hop++) {
      const target = new URL(admin.headers.get("location"),previewUrl);
      assert.equal(target.origin,previewUrl,`Admin redirected to ${target}`);
      admin=await fetch(target,{headers:{cookie:loginCookies},redirect:"manual"});
    }
    assert.equal(admin.status,200,`Admin ${admin.status}: ${admin.headers.get("location")}`);
    assert.match(await admin.text(),/Dashboard/);
    console.log(`PASS: public preview installation, redirects, login and wp-admin${phase === "verify-preview" ? " after Platform restart with the same port" : phase === "upgrade" ? " after recipe upgrade with the same account and port" : ""}.`);
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
    if (phase === "create") await client.projects.stop(project.id);
    if (phase === "verify-preview") {
      await client.projects.remove(project.id);
      await assert.rejects(fetch(previewUrl));
      console.log("PASS: package installation is idempotent and Project deletion closes preview ingress.");
    }
  }
}
