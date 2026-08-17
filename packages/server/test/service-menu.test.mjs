import assert from "node:assert/strict";
import test from "node:test";
import { defineService } from "../dist/index.js";

test("defineService accepts fixed dashboard menu actions", () => {
  const service = defineService({
    name: "@acme/workloads",
    menu: {
      title: "Workloads",
      items: [
        {
          title: "Functions",
          items: [
            {
              title: "Add Function",
              path: "/workloads/new",
              fixed: true,
              fixedOrder: 1,
            },
            {
              title: "Advanced",
              fixedActionScope: "inherit",
              items: [
                {
                  title: "Settings",
                  path: "/workloads/settings",
                },
              ],
            },
          ],
        },
      ],
    },
  });

  assert.equal(service.menu?.items?.[0]?.items?.[0]?.fixed, true);
  assert.equal(service.menu?.items?.[0]?.items?.[0]?.fixedOrder, 1);
  assert.equal(service.menu?.items?.[0]?.items?.[1]?.fixedActionScope, "inherit");
});

test("defineService rejects invalid fixed dashboard menu metadata", () => {
  assert.throws(
    () =>
      defineService({
        name: "@acme/bad-fixed",
        menu: {
          title: "Bad",
          items: [
            {
              title: "Add",
              path: "/bad/add",
              fixed: "yes",
            },
          ],
        },
      }),
    /Service menu fixed flag/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@acme/bad-fixed-order",
        menu: {
          title: "Bad",
          items: [
            {
              title: "Add",
              path: "/bad/add",
              fixed: true,
              fixedOrder: "first",
            },
          ],
        },
      }),
    /Service menu fixedOrder/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@acme/bad-fixed-scope",
        menu: {
          title: "Bad",
          items: [
            {
              title: "Nested",
              fixedActionScope: "forever",
              items: [
                {
                  title: "Child",
                  path: "/bad/child",
                },
              ],
            },
          ],
        },
      }),
    /Service menu fixedActionScope/,
  );
});
