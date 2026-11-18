// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/password/commonPasswords.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: imports use .js extensions.
import { COMMON_PASSWORDS_BY_LENGTH } from "./commonPasswords.generated.js";

// A list of the most frequent passwords. OWASP ASVS L1 (requirement 2.1.7) and
// NIST SP 800-63B tell applications to reject these passwords.
//
// `commonPasswords.generated.ts` contains the list. Its keys are password
// lengths and each of its arrays is in ascending order. Thus a lookup does one
// binary search in one small array.

/**
 * Put a password in the same form as the generated list: first the NFC
 * normalization, then lowercase.
 *
 * The comparison is not case-sensitive. Thus the list also rejects the usual
 * variants such as `Password123`.
 */
function normalizeForLookup(password: string): string {
  return password.normalize("NFC").toLowerCase();
}

/**
 * Tell if a password is one of the most frequent passwords.
 *
 * The operation is not case-sensitive, and it applies the NFC normalization
 * first.
 */
export function isCommonPassword(password: string): boolean {
  const normalized = normalizeForLookup(password);
  // Measure the length in Unicode code points, in the same way as the
  // generator script and `validatePasswordInputFormat`.
  const bucket = COMMON_PASSWORDS_BY_LENGTH[[...normalized].length];
  if (bucket === undefined) {
    return false;
  }

  // Binary search. The generator sorts each array with the default comparison
  // of JavaScript, which is the same comparison as `<` and `>` below.
  let low = 0;
  let high = bucket.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = bucket[middle];
    if (candidate === normalized) {
      return true;
    }
    if (candidate < normalized) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return false;
}
