import {
  mkdirSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { Server } from "node:http";
import { nodeAdapter as bindNodeRuntime } from "@zelavis/server/adapters/node";
import type {
  ZelavisAdapterBinding,
  ZelavisDashboardSettingsStore,
  ZelavisDashboardSettingsUpdate,
  ZelavisDashboardThemeMode,
} from "../index.js";
import { createLazyBoundValue, createRuntimeBackedAdapter } from "./_shared.js";

function normalizePathPart(part: string | undefined): string {
  if (!part) {
    return "";
  }

  const trimmed = part.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (path === undefined) {
    return fallback;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed === "/") {
    return "/";
  }

  const normalized = normalizePathPart(trimmed);
  return normalized ? `/${normalized}` : fallback;
}

function normalizeEditableRootPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return normalizePath(path, "/");
}

function isDashboardThemeMode(
  value: unknown,
): value is ZelavisDashboardThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

export function createFileDashboardSettingsStore(
  filePath = ".zelavis/dashboard-settings.json",
): ZelavisDashboardSettingsStore {
  const resolvedPath = resolve(filePath);

  function read(): ZelavisDashboardSettingsUpdate {
    if (!existsSync(resolvedPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as Record<
      string,
      unknown
    >;
    const settings: ZelavisDashboardSettingsUpdate = {};

    if (typeof parsed.rootPath === "string") {
      settings.rootPath = normalizeEditableRootPath(parsed.rootPath);
    }

    if (isDashboardThemeMode(parsed.theme)) {
      settings.theme = parsed.theme;
    }

    if (typeof parsed.pageBuilderEnabled === "boolean") {
      settings.pageBuilderEnabled = parsed.pageBuilderEnabled;
    }

    return settings;
  }

  function write(update: ZelavisDashboardSettingsUpdate) {
    const next = {
      ...read(),
      ...update,
    };
    const temporaryPath = `${resolvedPath}.tmp`;

    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temporaryPath, resolvedPath);

    return next;
  }

  return {
    read,
    write,
  };
}

export interface ZelavisNodeBinding extends ZelavisAdapterBinding {
  nodeServer(): Promise<Server>;
}

export function nodeAdapter() {
  return createRuntimeBackedAdapter<ZelavisNodeBinding>("node", ({ getRuntime }) => {
    const getServer = createLazyBoundValue(async () =>
      bindNodeRuntime(await getRuntime()),
    );

    return {
      async ready() {
        await getServer();
      },
      async nodeServer() {
        return getServer();
      },
    };
  });
}
