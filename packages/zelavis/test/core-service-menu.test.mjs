import assert from "node:assert/strict";
import test from "node:test";
import { validateServiceMenu } from "../dist/core/index.js";

test("validateServiceMenu accepts valid menu metadata", () => {
  const menu = {
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
  };

  assert.doesNotThrow(() => validateServiceMenu(menu));
  assert.equal(menu.items[0].items[0].fixed, true);
  assert.equal(menu.items[0].items[0].fixedOrder, 1);
  assert.equal(menu.items[0].items[1].fixedActionScope, "inherit");
});

test("validateServiceMenu accepts route-backed dynamic menu empty states", () => {
  const menu = {
    title: "Workloads",
    items: [
      {
        title: "Jobs",
        path: "/workloads",
        dynamicItems: {
          path: "/workloads/api/jobs/menu",
          emptyTitle: "No jobs yet",
          emptyPath: "/workloads/new",
        },
      },
    ],
  };

  assert.doesNotThrow(() => validateServiceMenu(menu));
});

test("validateServiceMenu accepts iframe page files separate from dashboard menu paths", () => {
  const menu = {
    title: "Acme Extension",
    path: "/acme",
    page: {
      id: "dashboard",
      title: "Acme Dashboard",
      bundle: "dashboard",
      file: "dashboard.html",
    },
    items: [
      {
        title: "Settings",
        path: "/acme/settings",
        page: {
          id: "settings",
          title: "Acme Settings",
          file: "settings.html",
        },
      },
    ],
  };

  assert.doesNotThrow(() => validateServiceMenu(menu));
  assert.equal(menu.page.file, "dashboard.html");
  assert.equal(menu.items[0].page.file, "settings.html");
});

test("validateServiceMenu rejects invalid iframe page files", () => {
  assert.throws(
    () =>
      validateServiceMenu({
        title: "Bad",
        path: "/bad",
        page: {
          id: "dashboard",
        },
      }),
    /page\.file/,
  );

  assert.throws(
    () =>
      validateServiceMenu({
        title: "Bad",
        path: "/bad",
        page: {
          id: "dashboard",
          file: 42,
        },
      }),
    /page metadata.*file/,
  );

  assert.throws(
    () =>
      validateServiceMenu({
        title: "Bad",
        path: "/bad",
        page: {
          id: "dashboard",
          file: "../dashboard.html",
        },
      }),
    /bundle-relative path/,
  );
});

test("validateServiceMenu rejects invalid dynamic menu empty state routes", () => {
  assert.throws(
    () =>
      validateServiceMenu({
        title: "Bad",
        path: "/bad",
        dynamicItems: {
          path: "/bad/menu",
          emptyPath: 42,
        },
      }),
    /emptyPath/,
  );
});

test("validateServiceMenu rejects invalid fixed dashboard menu metadata", () => {
  assert.throws(
    () =>
      validateServiceMenu({
        title: "Bad",
        items: [
          {
            title: "Add",
            path: "/bad/add",
            fixed: "yes",
          },
        ],
      }),
    /Service menu fixed flag/,
  );

  assert.throws(
    () =>
      validateServiceMenu({
        title: "Bad",
        items: [
          {
            title: "Add",
            path: "/bad/add",
            fixed: true,
            fixedOrder: "first",
          },
        ],
      }),
    /Service menu fixedOrder/,
  );

  assert.throws(
    () =>
      validateServiceMenu({
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
      }),
    /Service menu fixedActionScope/,
  );
});
