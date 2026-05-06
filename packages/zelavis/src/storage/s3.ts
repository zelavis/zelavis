import type {
  ZelavisFileStorage,
  ZelavisFileStorageEntry,
  ZelavisFileStorageObject,
  ZelavisFileStoragePutInput,
} from "../index.js";

const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface S3CompatibleFileStorageOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  fetch?: typeof fetch;
  defaultHeaders?: {
    cacheControl?: string;
    cacheControlPreset?: S3CacheControlPresetName;
    contentDisposition?: string;
    contentLanguage?: string;
  };
}

export const s3CacheControlPresets = Object.freeze({
  immutableAsset: "public, max-age=31536000, immutable",
  browserShort: "public, max-age=300, stale-while-revalidate=30",
  edgeShort: "public, max-age=60, s-maxage=300, stale-while-revalidate=60",
  privateDocument: "private, max-age=0, must-revalidate",
  noStore: "no-store",
});

export type S3CacheControlPresetName = keyof typeof s3CacheControlPresets;

export function resolveS3CacheControlPreset(
  preset: S3CacheControlPresetName,
) {
  return s3CacheControlPresets[preset];
}

function normalizeStoragePath(path: string) {
  return path.replace(/^\/+/, "");
}

function normalizeStoragePrefix(prefix: string | undefined) {
  if (!prefix) {
    return "";
  }

  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinStoragePath(prefix: string, path: string) {
  const normalizedPath = normalizeStoragePath(path);

  if (!prefix) {
    return normalizedPath;
  }

  return normalizedPath ? `${prefix}/${normalizedPath}` : prefix;
}

function stripStoragePrefix(path: string, prefix: string) {
  if (!prefix) {
    return path;
  }

  const withSlash = `${prefix}/`;
  return path.startsWith(withSlash) ? path.slice(withSlash.length) : path;
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function sha256Hex(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(key: Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    toArrayBuffer(new TextEncoder().encode(value)),
  );
  return new Uint8Array(signature);
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
) {
  const secret = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  const dateKey = await hmacSha256(secret, dateStamp);
  const regionKey = await hmacSha256(dateKey, region);
  const serviceKey = await hmacSha256(regionKey, "s3");
  return hmacSha256(serviceKey, "aws4_request");
}

function encodePath(path: string) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function formatAmzDate(date: Date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    dateTime: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function getTagValue(source: string, tag: string) {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

function parseS3ListXml(xml: string) {
  const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(
    ([, block]) => ({
      key: getTagValue(block, "Key") ?? "",
      size: Number(getTagValue(block, "Size") ?? "0"),
      lastModified: getTagValue(block, "LastModified"),
    }),
  );

  return {
    entries: contents.filter((entry) => entry.key.length > 0),
    truncated: getTagValue(xml, "IsTruncated") === "true",
    nextToken: getTagValue(xml, "NextContinuationToken"),
  };
}

function collectCustomMetadata(headers: Headers) {
  const metadataEntries: Array<readonly [string, string]> = [];
  headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith("x-amz-meta-")) {
      return;
    }

    metadataEntries.push([name.slice("x-amz-meta-".length), value] as const);
  });

  return metadataEntries.length > 0
    ? Object.fromEntries(metadataEntries)
    : undefined;
}

async function toBytes(
  body: ZelavisFileStoragePutInput["body"],
): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }

  if (body instanceof Uint8Array) {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("getReader" in body) ||
    typeof body.getReader !== "function"
  ) {
    throw new TypeError("Unsupported S3 file storage body input.");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }

    chunks.push(next.value);
    total += next.value.byteLength;
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

async function signedFetch(
  options: S3CompatibleFileStorageOptions,
  input: {
    method: string;
    path?: string;
    query?: Record<string, string | undefined>;
    headers?: HeadersInit;
    body?: Uint8Array;
  },
) {
  const prefix = normalizeStoragePrefix(options.prefix);
  const objectPath = input.path ? joinStoragePath(prefix, input.path) : prefix;
  const endpoint = options.endpoint
    ? new URL(options.endpoint)
    : new URL(`https://s3.${options.region}.amazonaws.com`);
  const forcePathStyle =
    options.forcePathStyle ?? Boolean(options.endpoint);
  const pathname = forcePathStyle
    ? `/${encodeURIComponent(options.bucket)}${objectPath ? `/${encodePath(objectPath)}` : ""}`
    : `${objectPath ? `/${encodePath(objectPath)}` : "/"}`;

  if (!forcePathStyle) {
    endpoint.hostname = `${options.bucket}.${endpoint.hostname}`;
  }

  endpoint.pathname = pathname;

  const queryEntries = Object.entries(input.query ?? {}).filter(
    ([, value]) => value !== undefined && value !== "",
  );
  queryEntries.sort(([left], [right]) => left.localeCompare(right));
  endpoint.search = "";
  for (const [key, value] of queryEntries) {
    endpoint.searchParams.append(key, value as string);
  }

  const bodyHash = input.body ? await sha256Hex(input.body) : EMPTY_BODY_SHA256;
  const now = new Date();
  const { dateTime, dateStamp } = formatAmzDate(now);
  const headers = new Headers(input.headers);
  headers.set("host", endpoint.host);
  headers.set("x-amz-content-sha256", bodyHash);
  headers.set("x-amz-date", dateTime);
  if (options.sessionToken) {
    headers.set("x-amz-security-token", options.sessionToken);
  }

  const canonicalHeaderNames: string[] = [];
  headers.forEach((_, name) => {
    canonicalHeaderNames.push(name.toLowerCase());
  });
  canonicalHeaderNames.sort();
  const canonicalHeaders = canonicalHeaderNames
    .map((name) => `${name}:${headers.get(name)?.trim().replace(/\s+/g, " ") ?? ""}\n`)
    .join("");
  const signedHeaders = canonicalHeaderNames.join(";");
  const canonicalQueryEntries: Array<readonly [string, string]> = [];
  endpoint.searchParams.forEach((value, key) => {
    canonicalQueryEntries.push([key, value] as const);
  });
  const canonicalQuery = canonicalQueryEntries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    endpoint.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    options.secretAccessKey,
    dateStamp,
    options.region,
  );
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  headers.set(
    "authorization",
    [
      `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", "),
  );

  const fetchImpl = options.fetch ?? fetch;
  return fetchImpl(endpoint, {
    method: input.method,
    headers,
    body: input.body ? toArrayBuffer(input.body) : undefined,
  });
}

async function headObject(
  options: S3CompatibleFileStorageOptions,
  path: string,
) {
  const response = await signedFetch(options, {
    method: "HEAD",
    path,
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to read S3 metadata for "${path}" (${response.status}).`,
    );
  }

  return response;
}

export function createS3CompatibleFileStorage(
  options: S3CompatibleFileStorageOptions,
): ZelavisFileStorage {
  return {
    async get(path): Promise<ZelavisFileStorageObject | undefined> {
      const response = await signedFetch(options, {
        method: "GET",
        path,
      });

      if (response.status === 404) {
        return undefined;
      }

      if (!response.ok) {
        throw new Error(`Failed to read S3 object "${path}" (${response.status}).`);
      }

      return {
        path: normalizeStoragePath(path),
        body: new Uint8Array(await response.arrayBuffer()),
        size: Number(response.headers.get("content-length") ?? "0") || undefined,
        updatedAt: response.headers.get("last-modified")
          ? new Date(response.headers.get("last-modified") as string)
          : undefined,
        contentType: response.headers.get("content-type") ?? undefined,
        cacheControl: response.headers.get("cache-control") ?? undefined,
        contentDisposition:
          response.headers.get("content-disposition") ?? undefined,
        metadata: collectCustomMetadata(response.headers),
      };
    },
    async put(input): Promise<ZelavisFileStorageEntry> {
      const body = await toBytes(input.body);
      const headers = new Headers();
      const defaultHeaders = options.defaultHeaders;
      const resolvedCacheControl =
        input.cacheControl ??
        defaultHeaders?.cacheControl ??
        (defaultHeaders?.cacheControlPreset
          ? resolveS3CacheControlPreset(defaultHeaders.cacheControlPreset)
          : undefined);
      if (input.contentType) {
        headers.set("content-type", input.contentType);
      }
      if (resolvedCacheControl) {
        headers.set("cache-control", resolvedCacheControl);
      }
      if (input.contentDisposition ?? defaultHeaders?.contentDisposition) {
        headers.set(
          "content-disposition",
          input.contentDisposition ?? (defaultHeaders?.contentDisposition as string),
        );
      }
      if (defaultHeaders?.contentLanguage) {
        headers.set("content-language", defaultHeaders.contentLanguage);
      }
      for (const [key, value] of Object.entries(input.metadata ?? {})) {
        headers.set(`x-amz-meta-${key}`, value);
      }

      const response = await signedFetch(options, {
        method: "PUT",
        path: input.path,
        headers,
        body,
      });

      if (!response.ok) {
        throw new Error(`Failed to write S3 object "${input.path}" (${response.status}).`);
      }

      return {
        path: normalizeStoragePath(input.path),
        size: body.byteLength,
        updatedAt: new Date(),
        contentType: input.contentType,
        cacheControl: resolvedCacheControl,
        contentDisposition:
          input.contentDisposition ?? defaultHeaders?.contentDisposition,
        metadata: {
          ...(input.metadata ?? {}),
          ...(defaultHeaders?.contentLanguage
            ? { contentLanguage: defaultHeaders.contentLanguage }
            : {}),
        },
      };
    },
    async delete(path) {
      const existing = await headObject(options, path);
      if (!existing) {
        return false;
      }

      const response = await signedFetch(options, {
        method: "DELETE",
        path,
      });

      if (!response.ok) {
        throw new Error(`Failed to delete S3 object "${path}" (${response.status}).`);
      }

      return true;
    },
    async list(prefix) {
      const normalizedPrefix = prefix ? normalizeStoragePath(prefix) : undefined;
      const entries: ZelavisFileStorageEntry[] = [];
      let continuationToken: string | undefined;

      while (true) {
        const response = await signedFetch(options, {
          method: "GET",
          query: {
            "list-type": "2",
            prefix: normalizedPrefix
              ? joinStoragePath(normalizeStoragePrefix(options.prefix), normalizedPrefix)
              : normalizeStoragePrefix(options.prefix) || undefined,
            "continuation-token": continuationToken,
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to list S3 objects (${response.status}).`);
        }

        const payload = parseS3ListXml(await response.text());
        entries.push(
          ...payload.entries.map((entry) => ({
            path: stripStoragePrefix(entry.key, normalizeStoragePrefix(options.prefix)),
            size: entry.size,
            updatedAt: entry.lastModified ? new Date(entry.lastModified) : undefined,
          })),
        );

        if (!payload.truncated || !payload.nextToken) {
          break;
        }

        continuationToken = payload.nextToken;
      }

      return entries.sort((left, right) => left.path.localeCompare(right.path));
    },
  };
}
