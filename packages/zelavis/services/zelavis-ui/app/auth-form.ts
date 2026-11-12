import type { ApiError } from "./api.ts";

export function authFormError(error: ApiError): string {
  const retry = error.status === 429 && /^\d{1,4}$/.test(error.retryAfter ?? "") ? ` Try again in ${error.retryAfter} seconds.` : "";
  return error.message + retry;
}
