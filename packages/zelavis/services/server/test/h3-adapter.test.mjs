import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { zelavisServer } from "../dist/index.js";
import { h3Adapter } from "../dist/adapters/h3.js";

test("h3Adapter preserves full external paths and falls through for host routes", async () => {
  const app = new H3();

  app.get("/hello", () => "Hello h3");

  const runtime = await zelavisServer({
    services: [
      {
        name: "demo",
        service: { label: "demo-service" },
        api: {
          v1: [
            {
              id: "demo.config",
              method: "GET",
              path: "/config",
              handler: ({ request }) => ({
                body: {
                  requestUrl: request.url,
                },
              }),
            },
          ],
        },
      },
    ],
    prefix: "/zelavis",
  });

  app.use("/**", h3Adapter(runtime));

  const hostResponse = await app.request("http://localhost/hello");
  assert.equal(hostResponse.status, 200);
  assert.equal(await hostResponse.text(), "Hello h3");

  const zelavisResponse = await app.request(
    "http://localhost/zelavis/demo/config?source=h3",
  );
  assert.equal(zelavisResponse.status, 200);
  assert.deepEqual(await zelavisResponse.json(), {
    requestUrl: "http://localhost/zelavis/demo/config?source=h3",
  });
});
