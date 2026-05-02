import { defineServerService, type ZelavisServerService } from "@zelavis/server";
import type { AuthApi } from "../core/types.js";
import {
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
} from "../core/errors.js";

function errorResponse(status: number, error: unknown) {
  return {
    status,
    body: {
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function getAuthErrorStatus(error: unknown, fallback = 500): number {
  if (error instanceof AuthNotFoundError) {
    return 404;
  }

  if (error instanceof AuthValidationError || error instanceof TypeError) {
    return 400;
  }

  if (error instanceof AuthDomainError) {
    return 400;
  }

  return fallback;
}

function authErrorResponse(error: unknown, fallback = 500) {
  return errorResponse(getAuthErrorStatus(error, fallback), error);
}

export function createAuthServerService(auth: AuthApi): ZelavisServerService<AuthApi> {
  return defineServerService({
    name: "auth",
    basePath: "/auth",
    service: auth,
    api: {
      v1: [
        {
          id: "auth.accounts.list",
          method: "GET",
          path: "/accounts",
          handler: async ({ service }) => ({
            status: 200,
            body: await service.accounts.list(),
          }),
        },
        {
          id: "auth.accounts.create",
          method: "POST",
          path: "/accounts",
          handler: async ({ service, body }) => {
            try {
              return {
                status: 201,
                body: await service.accounts.create(
                  body as Parameters<AuthApi["accounts"]["create"]>[0],
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.credentials.create",
          method: "POST",
          path: "/credentials",
          handler: async ({ service, body }) => {
            try {
              return {
                status: 201,
                body: await service.credentials.create(
                  body as Parameters<AuthApi["credentials"]["create"]>[0],
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.providers.list",
          method: "GET",
          path: "/providers",
          handler: ({ service }) => ({
            status: 200,
            body: service.authentication.listProviders(),
          }),
        },
        {
          id: "auth.authenticate",
          method: "POST",
          path: "/authenticate/:provider",
          handler: async ({ service, params, body }) => {
            try {
              return {
                status: 200,
                body: await service.authentication.authenticate(
                  params.provider,
                  body as Parameters<
                    AuthApi["authentication"]["authenticate"]
                  >[1],
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 404);
            }
          },
        },
        {
          id: "auth.sessions.listByAccountId",
          method: "GET",
          path: "/accounts/:accountId/sessions",
          handler: async ({ service, params }) => ({
            status: 200,
            body: await service.sessions.listByAccountId(params.accountId),
          }),
        },
      ],
    },
  });
}
