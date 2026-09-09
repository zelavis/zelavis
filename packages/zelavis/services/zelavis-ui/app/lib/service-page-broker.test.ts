import { describe, expect, it } from "vitest";

import {
  installServicePageBroker,
  isServicePageBrokerRequest,
  resolveBrokeredPath,
} from "./service-page-broker";

const GRANT = {
  serviceName: "@example/shop",
  apiPath: "/zelavis/api/v1/shop",
};

describe("a brokered request cannot leave the service's own namespace", () => {
  it("allows the namespace itself and paths under it", () => {
    expect(resolveBrokeredPath("", GRANT)).toBeUndefined();
    expect(resolveBrokeredPath("orders", GRANT)).toBe("/zelavis/api/v1/shop/orders");
    expect(resolveBrokeredPath("/orders", GRANT)).toBe("/zelavis/api/v1/shop/orders");
    expect(resolveBrokeredPath("orders?open=1", GRANT)).toBe(
      "/zelavis/api/v1/shop/orders?open=1",
    );
  });

  it("refuses a sibling namespace that shares a prefix", () => {
    // A plain startsWith on "/zelavis/api/v1/shop" would let this through.
    expect(resolveBrokeredPath("../shopadmin/secrets", GRANT)).toBeUndefined();
    expect(resolveBrokeredPath("../shop-admin", GRANT)).toBeUndefined();
  });

  it("treats a leading slash as the namespace root, not the site root", () => {
    // A page writing the full Platform path does not reach it. The result
    // stays inside the grant and 404s, rather than resolving to the real
    // service registry.
    expect(resolveBrokeredPath("/runtime/services", GRANT)).toBe(
      "/zelavis/api/v1/shop/runtime/services",
    );
    expect(resolveBrokeredPath("/zelavis/api/v1/shopadmin", GRANT)).toBe(
      "/zelavis/api/v1/shop/zelavis/api/v1/shopadmin",
    );
  });

  it("refuses traversal out of the namespace", () => {
    for (const path of [
      "../runtime/services",
      "../../runtime/config",
      "../../../../auth/sessions",
      "orders/../../runtime/services",
      "%2e%2e/runtime/services",
    ]) {
      expect(resolveBrokeredPath(path, GRANT), path).toBeUndefined();
    }
  });

  it("refuses anything that leaves the Platform", () => {
    for (const path of [
      "https://evil.test/steal",
      "//evil.test/steal",
      "http://evil.test",
      "javascript:alert(1)",
      "data:text/html,<script>",
    ]) {
      expect(resolveBrokeredPath(path, GRANT), path).toBeUndefined();
    }
  });

  it("refuses a non-string path", () => {
    expect(resolveBrokeredPath(undefined as never, GRANT)).toBeUndefined();
    expect(resolveBrokeredPath(42 as never, GRANT)).toBeUndefined();
  });
});

describe("broker messages", () => {
  it("only recognises its own message shape", () => {
    expect(
      isServicePageBrokerRequest({
        zelavis: "service-page-request",
        id: "1",
        path: "/orders",
      }),
    ).toBe(true);

    for (const value of [
      null,
      "service-page-request",
      { zelavis: "something-else", id: "1", path: "/x" },
      { zelavis: "service-page-request", path: "/x" },
      { zelavis: "service-page-request", id: 1, path: "/x" },
    ]) {
      expect(isServicePageBrokerRequest(value)).toBe(false);
    }
  });
});

describe("the broker answers only its own frame, and only within the grant", () => {
  function harness() {
    const target = new EventTarget();
    const previous = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = target;

    const replies: unknown[] = [];
    const contentWindow = { postMessage: (data: unknown) => replies.push(data) };
    const frame = { contentWindow } as unknown as HTMLIFrameElement;

    const calls: string[] = [];
    const fetchImplementation = (async (path: string) => {
      calls.push(path);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const teardown = installServicePageBroker({
      grant: GRANT,
      frame,
      fetchImplementation,
    });

    const send = async (data: unknown, source: unknown = contentWindow) => {
      const event = new Event("message") as Event & Record<string, unknown>;
      event.data = data;
      Object.defineProperty(event, "source", { value: source });
      target.dispatchEvent(event);
      // Let the handler's awaits settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const restore = () => {
      teardown();
      (globalThis as Record<string, unknown>).window = previous;
    };

    return { send, replies, calls, restore, contentWindow };
  }

  it("performs a request inside the grant and replies to the frame", async () => {
    const { send, replies, calls, restore } = harness();

    await send({ zelavis: "service-page-request", id: "1", path: "orders" });

    expect(calls).toEqual(["/zelavis/api/v1/shop/orders"]);
    expect(replies).toEqual([
      {
        zelavis: "service-page-response",
        id: "1",
        status: 200,
        ok: true,
        body: { ok: true },
      },
    ]);
    restore();
  });

  it("refuses a request outside the grant without calling anything", async () => {
    const { send, replies, calls, restore } = harness();

    await send({
      zelavis: "service-page-request",
      id: "2",
      path: "../../runtime/services",
    });

    // The refusal has to happen before the fetch, not after.
    expect(calls).toEqual([]);
    expect(replies).toHaveLength(1);
    expect((replies[0] as { error?: string }).error).toMatch(/its own API/);
    restore();
  });

  it("ignores a message from any window other than its frame", async () => {
    const { send, replies, calls, restore } = harness();

    // Identity is the sending window. Another frame on the page, or the page
    // itself, must not be able to spend this grant.
    await send(
      { zelavis: "service-page-request", id: "3", path: "orders" },
      { postMessage() {} },
    );

    expect(calls).toEqual([]);
    expect(replies).toEqual([]);
    restore();
  });

  it("refuses a method a page has no business using", async () => {
    const { send, replies, calls, restore } = harness();

    await send({
      zelavis: "service-page-request",
      id: "4",
      path: "orders",
      method: "TRACE",
    });

    expect(calls).toEqual([]);
    expect((replies[0] as { error?: string }).error).toMatch(/not available/);
    restore();
  });

  it("stops answering once torn down", async () => {
    const { send, replies, restore } = harness();
    restore();

    await send({ zelavis: "service-page-request", id: "5", path: "orders" });

    expect(replies).toEqual([]);
  });
});
