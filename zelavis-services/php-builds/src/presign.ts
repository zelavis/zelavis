import { createHash, createHmac } from "node:crypto";

/**
 * An AWS Signature Version 4 presigned URL (query-string form), as Cloudflare R2's S3 API accepts. Pure: the
 * time and the credentials are arguments, so the signature can be checked against AWS's published test vector.
 * The payload is unsigned and only `host` is a signed header, so whoever holds the URL can upload exactly this
 * object until it expires and nothing else.
 */
export interface PresignInput {
  readonly method: "GET" | "PUT";
  readonly host: string;
  /** The object's path, starting with "/" (the bucket first on R2's path-style address). */
  readonly path: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresSeconds: number;
  readonly now: Date;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value, "utf8").digest();
/** RFC 3986 percent-encoding; "/" is kept in a path and encoded in a query value. */
const encode = (value: string, keepSlash: boolean) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? "/" : "%2F");

export function presignUrl(input: PresignInput): string {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 604_800) {
    throw new RangeError("A presigned URL lives between one second and seven days.");
  }
  const stamp = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query.map(([name, value]) => `${encode(name, false)}=${encode(value, false)}`).sort().join("&");
  const path = encode(input.path, true);
  const canonicalRequest = [input.method, path, canonicalQuery, `host:${input.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return `https://${input.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
