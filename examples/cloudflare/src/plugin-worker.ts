import type { ZelavisServiceActivationRequest } from "zelavis";

type ServiceWorkerEnv = {
  ZELAVIS_ROOT_PATH?: string;
};

async function readActivationRequest(
  request: Request,
): Promise<ZelavisServiceActivationRequest> {
  const body = await request.json();

  if (
    typeof body !== "object" ||
    body === null ||
    !("serviceName" in body) ||
    typeof body.serviceName !== "string" ||
    !("action" in body) ||
    (body.action !== "register" &&
      body.action !== "install" &&
      body.action !== "uninstall" &&
      body.action !== "update") ||
    !("registry" in body) ||
    !Array.isArray(body.registry)
  ) {
    throw new TypeError("Invalid Zelavis service activation request.");
  }

  return body as ZelavisServiceActivationRequest;
}

export default {
  async fetch(request: Request, env: ServiceWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/__zelavis/service/activate") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          allow: "POST",
        },
      });
    }

    try {
      const activation = await readActivationRequest(request);

      return Response.json({
        status: "active",
        message: `${activation.serviceName} ${activation.action} accepted at ${
          env.ZELAVIS_ROOT_PATH ?? "/zelavis"
        }.`,
      });
    } catch (error) {
      return Response.json(
        {
          status: "pending",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      );
    }
  },
};
