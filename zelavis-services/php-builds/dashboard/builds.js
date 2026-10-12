// The page talks to this service's own API through the dashboard (the broker): it holds no credentials.
const pending = new Map();
let counter = 0;
window.addEventListener("message", (event) => {
  const reply = event.data;
  if (!reply || reply.zelavis !== "service-page-response" || !pending.has(reply.id)) return;
  const { resolve, reject } = pending.get(reply.id);
  pending.delete(reply.id);
  if (reply.error) reject(new Error(reply.error)); else resolve(reply);
});

function call(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const id = `r${(counter += 1)}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("The dashboard did not answer; open this page from the dashboard.")); }, 60_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    window.parent.postMessage({ zelavis: "service-page-request", id, path, method, body }, "*");
  }).then((reply) => {
    if (!reply.ok) throw new Error(reply.body?.error ?? `The request failed (${reply.status}).`);
    return reply.body;
  });
}

const text = (value) => document.createTextNode(String(value));
const element = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) { if (name === "class") node.className = value; else node.setAttribute(name, value); }
  for (const child of children) node.append(typeof child === "string" ? text(child) : child);
  return node;
};
const megabytes = (kib) => (kib == null ? "unknown" : `${(kib / 1048576).toFixed(1)} GB`);

let host;
const hostSection = document.getElementById("host");
const goButton = document.getElementById("go");
const startNote = document.getElementById("startNote");
const body = document.getElementById("builds");

function showHost() {
  const { report, containers, mirror } = host;
  const engine = !containers.installed ? "not installed" : !containers.reachable ? "installed, not running" : `running (${containers.version}${containers.rootless ? ", rootless" : ""})`;
  hostSection.replaceChildren(element("dl", {},
    element("dt", {}, "Machine"), element("dd", {}, `${report.architecture ?? "unknown"}, ${report.cpus ?? "?"} cores, ${megabytes(report.memoryAvailableKiB)} memory free`),
    element("dt", {}, "Disk"), element("dd", {}, `${megabytes(report.rootFilesystemFreeKiB)} free on /`),
    element("dt", {}, "Container engine"), element("dd", {}, engine),
    element("dt", {}, "Mirror"), element("dd", {}, mirror.configured ? `configured${mirror.publicBase ? `, serving ${mirror.publicBase}` : ""}` : "not configured (set the ZELAVIS_PHP_BUILDS_R2_* variables)"),
  ));
  const ready = containers.reachable && containers.runningBuilds === 0;
  goButton.disabled = !ready;
  startNote.textContent = ready ? "" : !containers.installed ? "A container engine is needed on this server." : !containers.reachable ? "Start the container engine first." : "A build is already running.";
}

function pinData(job) {
  return (job.builds ?? []).map((build) => {
    const match = build.file.match(/^php-(\d+\.\d+\.\d+)-[0-9a-f]{8}-(cli|fpm)-((?:linux|macos)-(?:x86_64|aarch64))\.tar\.gz$/);
    if (!match) return "";
    return JSON.stringify({ php: match[1], sapi: match[2], platform: match[3], file: build.file, sha256: build.sha256, bytes: build.bytes, executable: match[2] === "cli" ? "php" : "php-fpm" });
  }).filter(Boolean).join("\n");
}

function renderJob(job) {
  const actions = element("div", { class: "row" });
  const act = (label, run, enabled = true) => {
    const button = element("button", {}, label);
    button.disabled = !enabled;
    button.addEventListener("click", async () => { button.disabled = true; try { await run(); } catch (error) { alert(error.message); } await refresh(); });
    actions.append(button);
  };
  act("Refresh", async () => {});
  act("Upload to mirror", () => call(`/builds/${job.job}/upload`, "POST"), job.state === "succeeded" && host?.mirror.configured);
  act("Remove", () => call(`/builds/${job.job}`, "DELETE"), job.state !== "cleaned");
  const details = element("div", {});
  if (job.message) details.append(element("div", { class: "error" }, job.message));
  if (job.log) details.append(element("pre", {}, job.log.split("|").join("\n")));
  for (const build of job.builds ?? []) {
    const upload = job.uploads?.[build.file];
    details.append(element("div", {}, element("code", {}, build.file), ` ${build.bytes} bytes `, element("code", {}, build.sha256.slice(0, 12)),
      upload ? element("span", { class: `state ${upload.state}` }, ` ${upload.state}`) : ""));
  }
  const pin = pinData(job);
  if (pin) details.append(element("div", { class: "note" }, "For distribution/php-builds/pin.mjs (builds.jsonl):"), element("pre", {}, pin));
  const row = element("tr", {},
    element("td", {}, element("code", {}, job.job.slice(0, 8))), element("td", {}, job.php),
    element("td", {}, element("span", { class: `state ${job.state}` }, job.state), job.exitCode != null ? ` (exit ${job.exitCode})` : ""),
    element("td", {}, new Date(job.createdAt).toLocaleString()),
    element("td", {}));
  const cell = row.lastElementChild;
  cell.append(actions);
  const more = element("tr", {}, element("td", { colspan: "5" }, details));
  return [row, more];
}

async function refresh() {
  try {
    host = await call("/host");
    showHost();
    const { builds } = await call("/builds");
    const live = builds.filter((job) => ["starting", "running", "succeeded"].includes(job.state));
    const fresh = new Map(await Promise.all(live.map(async (job) => [job.job, await call(`/builds/${job.job}`).catch(() => job)])));
    const rows = builds.filter((job) => job.state !== "cleaned").flatMap((job) => renderJob(fresh.get(job.job) ?? job));
    body.replaceChildren(...(rows.length ? rows : [element("tr", {}, element("td", { colspan: "5", class: "note" }, "No builds yet."))]));
  } catch (error) {
    hostSection.replaceChildren(element("span", { class: "error" }, error.message));
  }
}

document.getElementById("start").addEventListener("submit", async (event) => {
  event.preventDefault();
  goButton.disabled = true;
  startNote.textContent = "Starting…";
  try { await call("/builds", "POST", { php: document.getElementById("php").value.trim() }); startNote.textContent = ""; }
  catch (error) { startNote.textContent = error.message; startNote.className = "error"; }
  await refresh();
});

await refresh();
setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 8_000);
