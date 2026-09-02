import assert from "node:assert/strict";
import test from "node:test";

import { projectRuntimePermissions } from "../dist/platform/project-gateway.js";

const PROJECT = "shop";

test("a Project's own services are reachable by someone who owns it", () => {
  const granted = projectRuntimePermissions(
    { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] },
    PROJECT,
  );

  // A Project runs its own workloads, storage, and database services, and they
  // enforce their own permissions. Nothing mapped to them, so an owner holding
  // full Platform authority arrived inside their own Project with none of them
  // and those screens returned 403.
  for (const permission of [
    "workloads.view",
    "workloads.manage",
    "workloads.logs.read",
    "storage.read",
    "storage.write",
    "database.inspect",
    "database.backup",
    "database.restore",
  ]) {
    assert.ok(granted.includes(permission), permission);
  }
});

test("viewing a Project does not authorize changing it", () => {
  const granted = projectRuntimePermissions(
    {
      id: "viewer",
      type: "user",
      permissions: [],
      grants: [
        { permission: "project.view", scope: { type: "project", projectId: PROJECT } },
      ],
    },
    PROJECT,
  );

  // Viewing implies seeing what runs in the Project. It does not imply
  // changing it, and nothing destructive rides along.
  assert.ok(granted.includes("workloads.view"));
  assert.ok(granted.includes("database.inspect"));
  assert.ok(granted.includes("storage.read"));

  for (const permission of [
    "workloads.manage",
    "storage.write",
    "database.restore",
    "database.backup",
    "system.services.manage",
  ]) {
    assert.ok(!granted.includes(permission), permission);
  }
});

test("authority over one Project does not reach another", () => {
  const granted = projectRuntimePermissions(
    {
      id: "viewer",
      type: "user",
      permissions: [],
      grants: [
        {
          permission: "project.runtime.manage",
          scope: { type: "project", projectId: "other" },
        },
      ],
    },
    PROJECT,
  );

  assert.deepEqual(granted, []);
});

test("the forwarded envelope stays bounded", () => {
  const granted = projectRuntimePermissions(
    { id: "owner", type: "user", permissions: ["*"], roles: ["owner"] },
    PROJECT,
  );

  // A wildcard expands to a named list rather than forwarding a wildcard, so a
  // permission added to the Project runtime later is not granted retroactively.
  assert.ok(!granted.includes("*"));
  assert.ok(granted.length > 0);
});

test("nobody gets anything without a principal", () => {
  assert.deepEqual(projectRuntimePermissions(undefined, PROJECT), []);
});
