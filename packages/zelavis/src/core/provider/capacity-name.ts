/** Shared hostname formatting; hosts and Web Crypto callers supply the same SHA-256 digest. */
export function capacityNodeNameFromDigest(requestId: string, digest: string): string {
  if (typeof requestId !== "string" || !requestId.trim()) throw new TypeError("requestId must be a non-empty string.");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("A SHA-256 digest is required.");
  const slug = requestId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42).replace(/-+$/g, "");
  return `zelavis-${slug || "node"}-${digest.slice(0, 12)}`;
}
