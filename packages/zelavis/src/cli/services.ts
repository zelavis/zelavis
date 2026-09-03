export type RuntimeServiceStatus = "installed" | "available";
export type RuntimeServiceSource = "official" | "community";

export interface RuntimeServiceRegistryEntry {
  name: string;
  version?: string;
  specifier?: string;
  status: RuntimeServiceStatus;
  source?: RuntimeServiceSource;
  order?: number;
}

export interface RuntimeServiceActivationResult {
  status: "active" | "pending";
  message?: string;
}

export interface RuntimeServiceRegistryMutationResult {
  services: RuntimeServiceRegistryEntry[];
  activation?: RuntimeServiceActivationResult;
}

export interface RuntimeServiceRegistryCreateInput {
  specifier: string;
  name?: string;
  status?: RuntimeServiceStatus;
  source?: RuntimeServiceSource;
  order?: number;
}

export interface RuntimeServiceRegistryUpdateInput {
  status?: RuntimeServiceStatus;
  source?: RuntimeServiceSource;
  order?: number;
}

export interface RuntimeServicesClientOptions {
  url?: string;
  fetch?: typeof fetch;
}

const DEFAULT_RUNTIME_URL = "http://localhost:3000/zelavis";

export function resolveRuntimeApiBase(url = DEFAULT_RUNTIME_URL): string {
  const normalized = url.trim().replace(/\/+$/, "");

  if (!normalized) {
    throw new Error("Runtime URL cannot be empty.");
  }

  if (/\/api\/[^/]+$/u.test(normalized)) {
    return normalized;
  }

  return `${normalized}/api/v1`;
}

async function readJson<TBody>(
  response: Response,
  url: string,
): Promise<TBody> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : undefined;

  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Request failed with status ${response.status}.`;

    throw new Error(`${message} (${url})`);
  }

  return body as TBody;
}

async function requestJson<TBody>(
  path: string,
  options: RuntimeServicesClientOptions & {
    method?: string;
    body?: unknown;
  } = {},
): Promise<TBody> {
  const fetcher = options.fetch ?? fetch;
  const apiBase = resolveRuntimeApiBase(options.url);
  const url = `${apiBase}${path}`;
  const response = await fetcher(url, {
    method: options.method,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return readJson<TBody>(response, url);
}

export async function listRuntimeServices(
  options: RuntimeServicesClientOptions = {},
): Promise<RuntimeServiceRegistryEntry[]> {
  const body = await requestJson<{ services: RuntimeServiceRegistryEntry[] }>(
    "/runtime/services",
    options,
  );

  return body.services;
}

export async function registerRuntimeService(
  input: RuntimeServiceRegistryCreateInput,
  options: RuntimeServicesClientOptions = {},
): Promise<RuntimeServiceRegistryMutationResult> {
  if (!input.specifier.trim()) {
    throw new Error("Service registration requires a specifier.");
  }

  return requestJson<RuntimeServiceRegistryMutationResult>(
    "/runtime/services",
    {
      ...options,
      method: "POST",
      body: input,
    },
  );
}

export async function updateRuntimeService(
  name: string,
  input: RuntimeServiceRegistryUpdateInput,
  options: RuntimeServicesClientOptions = {},
): Promise<RuntimeServiceRegistryMutationResult> {
  if (!name.trim()) {
    throw new Error("Service name is required.");
  }

  return requestJson<RuntimeServiceRegistryMutationResult>(
    `/runtime/services/${encodeURIComponent(name)}`,
    {
      ...options,
      method: "PATCH",
      body: input,
    },
  );
}

export function formatRuntimeServiceList(
  services: readonly RuntimeServiceRegistryEntry[],
): string {
  if (services.length === 0) {
    return "No runtime services are registered.";
  }

  const rows = services.map((service) => {
    const version = service.version ? `@${service.version}` : "";
    const source = service.source ? ` ${service.source}` : "";
    return `${service.status.padEnd(9)} ${service.name}${version}${source}`;
  });

  return rows.join("\n");
}

export function formatActivationResult(
  activation: RuntimeServiceActivationResult | undefined,
): string | undefined {
  if (!activation) {
    return undefined;
  }

  return activation.message
    ? `${activation.status}: ${activation.message}`
    : activation.status;
}

export interface RuntimeServiceExtension {
  name: string;
  version?: string;
  status: RuntimeServiceStatus;
  source?: RuntimeServiceSource;
  specifier?: string;
  capabilities: readonly string[];
  marketplace?: { title?: string; summary?: string };
}

export interface RuntimeExtensionPoint {
  owner: string;
  ownerInstalled: boolean;
  capabilities: readonly string[];
  extensions: readonly RuntimeServiceExtension[];
}

/**
 * Lists services that extend another, grouped by what they extend.
 *
 * Separate from `services list` on purpose: an extension belongs beside the
 * plugin it extends rather than in a general catalogue, where a payment
 * provider sitting next to a dashboard theme tells nobody anything.
 */
export async function listRuntimeExtensions(
  options: RuntimeServicesClientOptions & { owner?: string } = {},
): Promise<RuntimeExtensionPoint[]> {
  const query = options.owner
    ? `?owner=${encodeURIComponent(options.owner)}`
    : "";
  const body = await requestJson<{ extensionPoints: RuntimeExtensionPoint[] }>(
    `/runtime/extensions${query}`,
    options,
  );

  return body.extensionPoints;
}

export function formatRuntimeExtensions(
  points: readonly RuntimeExtensionPoint[],
): string {
  if (points.length === 0) {
    return "No installed service declares an extension point.";
  }

  return points
    .map((point) => {
      const heading = point.ownerInstalled
        ? point.owner
        : `${point.owner} (not installed)`;
      const rows = point.extensions.map((extension) => {
        const version = extension.version ? `@${extension.version}` : "";
        const title = extension.marketplace?.title
          ? `  ${extension.marketplace.title}`
          : "";
        return `  ${extension.status.padEnd(9)} ${extension.name}${version}${title}`;
      });
      return [heading, ...rows].join("\n");
    })
    .join("\n\n");
}
