const COMPATIBILITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalize a Zelavis compatibility date.
 *
 * Compatibility dates are deliberately plain ISO calendar dates so manifests,
 * providers, and runtimes can persist them without depending on host time zones.
 */
export function defineCompatibilityDate(value: string): string {
  if (typeof value !== "string" || !COMPATIBILITY_DATE_PATTERN.test(value)) {
    throw new TypeError(
      "Compatibility date must use the YYYY-MM-DD calendar date format.",
    );
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError(`Compatibility date "${value}" is not a valid date.`);
  }

  return value;
}
