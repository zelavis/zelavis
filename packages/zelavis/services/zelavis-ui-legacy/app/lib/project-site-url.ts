import type { RuntimeProject } from "./runtime-api";

/** A browser-facing site address, distinct from the Agent's private target. */
export function projectSiteUrl(project: RuntimeProject, browserUrl?: string): string | undefined {
  if (project.runtime.status !== "running") return undefined;
  const location = browserUrl ?? globalThis.location?.href;
  if (!location) return undefined;
  let browser: URL;
  try { browser = new URL(location); } catch { return undefined; }
  if (project.preview?.status === "ready" && Number.isInteger(project.preview.port) && project.preview.port! >= 1024 && project.preview.port! <= 65535) {
    const site = new URL(browser.origin);
    site.protocol = "http:";
    site.port = String(project.preview.port);
    site.pathname = "/";
    return site.href;
  }
  // A custom runtime without preview ingress may still be opened locally.
  // A loopback target must never be offered to a browser on another machine.
  if (!project.preview && project.runtime.url) {
    let runtime: URL;
    try { runtime = new URL(project.runtime.url); } catch { return undefined; }
    const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (local.has(browser.hostname) && local.has(runtime.hostname)) return runtime.href;
  }
  return undefined;
}
