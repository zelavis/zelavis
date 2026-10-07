import { createHash } from "node:crypto";
import { defineServerComponent, view, type ServerViewDefinition } from "fuzor/server-components/server";
import type { ServerRequestContext } from "fuzor/server";
import template from "./database.fragment.html";
import workspace from "./database.view-client.ts";
import { refresh } from "./database.handlers.ts";
import { pageNumber } from "../grids/model.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
import { databaseRoutes } from "../routes.ts";
const database = defineServerComponent(async (context: ServerRequestContext) => {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30000)]);
    // This origin is operator configuration. A caller's Host header never chooses the upstream.
    const origin = new URL(process.env.ZELAVIS_DEV_SERVER ?? "http://127.0.0.1:3000").origin;
    let requiresLogin = false;
    const projectId = context.params.projectId;
    const read = async (path: string, body?: unknown) => {
      if (!path.startsWith("/zelavis/api/") || path.includes("..")) throw new Error("Invalid dashboard API mount");
      const response = await fetch(new URL(path, origin), { signal, method: body === undefined ? "GET" : "POST", redirect: "error", headers: {
        accept: "application/json", origin,
        ...(context.request.headers.get("cookie") ? { cookie: context.request.headers.get("cookie")! } : {}),
        ...(context.request.headers.get("authorization") ? { authorization: context.request.headers.get("authorization")! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { requiresLogin ||= response.status === 401; throw new Error(response.status === 401 ? "Sign in to open this project's database." : `Database request failed (${response.status}).`); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Database response has no body");
      const decoder = new TextDecoder(); let text = "", bytes = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8 * 1024 * 1024) throw new Error("Dashboard response exceeds the loaded-page limit"); text += decoder.decode(part.value, { stream: true }); }
        text += decoder.decode();
      } finally { await reader.cancel(); reader.releaseLock(); }
      return JSON.parse(text) as unknown;
    };
    try {
      const control = object(await read("/zelavis/api/v1/runtime/config"));
      const base = String(object(control.api).basePath);
      if (!projectId) throw new Error("A database view requires a project ID");
      const projects: Record<string, unknown>[] = array(object(await read(`${base}/runtime/projects`)).projects).map(value => { const project = object(value); return { ...project, status: object(project.runtime).status }; });
      const project = projects.find(entry => entry.id === projectId);
      if (!project) throw new Error("Project not found");
      if (project.status !== "running") throw new Error("Start this project to open its database");
      const proxy = `${base}/runtime/projects/${encodeURIComponent(projectId)}/proxy`;
      const runtime = object(await read(`${proxy}/zelavis/api/v1/runtime/config`));
      if (object(object(runtime.capabilities).database).available !== true) throw new Error("This project does not expose a Zelavis database");
      const projectBase = String(object(runtime.api).basePath);
      if (!projectBase.startsWith("/zelavis/api/")) throw new Error("Invalid project API mount");
      const apiBase = proxy + projectBase;
      const scoped = { ...runtime, api: { basePath: apiBase } };
      const menu = await read(`${apiBase}/database/menu/tables`);
      const tenant = context.url.searchParams.get("databaseTenant") ?? "";
      const collection = context.url.searchParams.get("databaseTable") ?? "";
      const systemView = context.url.searchParams.get("databaseSystemView") ?? "";
      const offset = pageNumber(context.url.searchParams.get("databaseOffset"), 0, 1000000);
      const limit = Math.max(1, pageNumber(context.url.searchParams.get("databaseLimit"), 25, 250));
      let choices = array(object(menu).items);
      if (context.url.pathname.includes("/content") && tenant) choices = array(object(await read(`${apiBase}/database/documents/collections?tenantId=${encodeURIComponent(tenant)}`)).collections).filter(value => object(value).surface === "content-studio").map(value => ({ title: object(value).name, search: { databaseTenant: tenant, databaseTable: object(value).name } }));
      let records: unknown[] = [];
      if (tenant && systemView) records = array(object(await read(`${apiBase}/database/maintenance/system/views/${encodeURIComponent(systemView)}?tenantId=${encodeURIComponent(tenant)}&limit=50`)).rows);
      else if (tenant && collection) records = array(object(await read(`${apiBase}/database/documents/${encodeURIComponent(collection)}/query`, { tenantId: tenant, limit, offset })).documents);
      const props = { projectId, apiBase, tenant, collection, systemView, offset, limit, readonly: Boolean(systemView), recordsJson: JSON.stringify(records), choicesJson: JSON.stringify(choices), navigationJson: JSON.stringify({ project, projects, runtime: scoped, menu }) };
      const key = createHash("sha256").update(JSON.stringify([projectId, tenant, collection, systemView])).digest("hex").slice(0, 24);
      return view.fragment(template.id, "database-frame", { summary: `Server view · ${records.length} records · ${new Date().toISOString()}` }, { handlers: { refresh: view.handler(event => {
        event.element.ownerDocument.dispatchEvent(new CustomEvent("newui:refresh", { detail: { projectId } }));
      }) }, slots: { workspace: [view.client(workspace, key, props)] } });
    } catch (error) {
      if (signal.aborted) throw error;
      return view.fragment(template.id, "database-error", { summary: error instanceof Error ? error.message : "Could not open the database" }, { handlers: { refresh: view.handler(refresh) }, slots: { workspace: [view.client(workspace, "unavailable", { error: true, signin: requiresLogin })] } });
    }
});
const streamedDatabase = defineServerComponent((context: ServerRequestContext) => view.boundary(
  createHash("sha256").update(JSON.stringify([context.params.projectId, context.url.searchParams.get("databaseTenant") ?? "", context.url.searchParams.get("databaseTable") ?? "", context.url.searchParams.get("databaseSystemView") ?? ""])).digest("hex").slice(0, 24),
  [view.fragment(template.id, "database-loading", { summary: "Loading database…" }, { handlers: { refresh: view.handler(refresh) } })],
  [view.server(database, context)],
));
export default {
  streaming: true,
  routes: Object.fromEntries(databaseRoutes.map(route => [route, streamedDatabase])),
  // Scope is an opaque session partition, never an authentication or authorization decision.
  // Every API request above still authenticates and authorizes through Zelavis itself.
  scope: context => createHash("sha256").update(context.request.headers.get("cookie") ?? "").update(context.request.headers.get("authorization") ?? "").digest("hex").slice(0, 32),
} satisfies ServerViewDefinition;
