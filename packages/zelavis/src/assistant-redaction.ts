/**
 * Removes credential-shaped values from what a tool returns before it reaches
 * the model provider.
 *
 * This is defense in depth, not a boundary: it cannot know every secret, so the
 * real controls are what the tools can read at all (no identity records, one
 * fixed tenant) and the caller's own authority. It exists because logs and
 * records written by other code sometimes contain a token they should not.
 */
const REDACTED = "[redacted]";

const SECRET_KEY = /(^|[_-])(password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)s?($|[_-])/i;

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bzvs_[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(authorization|x-zelavis-authority|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi,
  /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*)\s*[:=]\s*[^\s,;'"]+/gi,
];

export function redactText(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, (match, name: unknown) =>
      typeof name === "string" && !match.startsWith("-----") && !/^Bearer/i.test(match)
        ? `${name}=${REDACTED}`
        : REDACTED,
    );
  }
  return result;
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) && entry !== null && entry !== undefined
        ? REDACTED
        : redactSecrets(entry, depth + 1),
    ]),
  );
}
