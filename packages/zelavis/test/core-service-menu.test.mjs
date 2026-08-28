import assert from "node:assert/strict";
import test from "node:test";
import { defineService } from "../dist/core/index.js";

test('defineService accepts core platform services', () => {
  const service = defineService({
    name: "zelavis/platform",
    kind: "core",
    service: {},
  });

  assert.equal(service.kind, "core");
});

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

test("defineService accepts route-backed dynamic menu empty states", () => {
  const service = defineService({
    name: "@acme/workloads",
    menu: {
      title: "Workloads",
      items: [
        {
          title: "Jobs",
          path: "/workloads",
          dynamicItems: {
            path: "/workloads/menu/jobs",
            emptyTitle: "No jobs yet",
            emptyPath: "/workloads",
            emptySearch: { workloadView: "jobs" },
          },
        },
      ],
    },
  });

  assert.equal(service.menu?.items?.[0]?.dynamicItems?.emptyPath, "/workloads");
  assert.deepEqual(service.menu?.items?.[0]?.dynamicItems?.emptySearch, {
    workloadView: "jobs",
  });
});

test("defineService accepts iframe page files separate from dashboard menu paths", () => {
  const service = defineService({
    name: "@acme/embedded",
    menu: {
      title: "Embedded",
      path: "/embedded",
      page: {
        id: "dashboard",
        file: "dashboard.html",
      },
      items: [
        {
          title: "Settings",
          path: "/embedded/settings",
          page: {
            id: "settings",
            file: "settings.html",
          },
        },
      ],
    },
  });

  assert.equal(service.menu?.page?.file, "dashboard.html");
  assert.equal(service.menu?.items?.[0]?.page?.file, "settings.html");
});

test("defineService rejects invalid iframe page files", () => {
  assert.throws(
    () =>
      defineService({
        name: "@acme/missing-page-file",
        menu: {
          title: "Bad",
          path: "/bad",
          page: {
            id: "dashboard",
          },
        },
      }),
    /page\.file/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@acme/bad-page-file",
        menu: {
          title: "Bad",
          path: "/bad",
          page: {
            id: "dashboard",
            file: 42,
          },
        },
      }),
    /page metadata.*file/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@acme/bad-page-file-path",
        menu: {
          title: "Bad",
          path: "/bad",
          page: {
            id: "dashboard",
            file: "../dashboard.html",
          },
        },
      }),
    /bundle-relative path/,
  );
});

test("defineService rejects invalid dynamic menu empty state routes", () => {
  assert.throws(
    () =>
      defineService({
        name: "@acme/bad-empty-path",
        menu: {
          title: "Bad",
          path: "/bad",
          dynamicItems: {
            path: "/bad/menu",
            emptyPath: 42,
          },
        },
      }),
    /emptyPath/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@acme/bad-empty-search",
        menu: {
          title: "Bad",
          path: "/bad",
          dynamicItems: {
            path: "/bad/menu",
            emptySearch: ["bad"],
          },
        },
      }),
    /emptySearch/,
  );
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
