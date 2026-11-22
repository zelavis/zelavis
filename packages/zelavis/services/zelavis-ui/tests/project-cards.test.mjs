import test from "node:test";
import assert from "node:assert/strict";
import { isManagedProject, shouldShowCardUpgradeNotice, upgradeDoneMessage } from "../app/project-upgrade-model.ts";

test("managed apps never show routine Update recipe banners on /projects cards", () => {
  const wordpress = {
    id: "wp",
    name: "WordPress",
    recipe: { name: "@zelavis/wordpress", version: "1.0.1", managed: { adminTitle: "WordPress Admin", adminPath: "/wp-admin/" } },
    capabilities: { recipeUpdateMode: "integration" },
    recipeStatus: { state: "upgradeAvailable", version: "1.0.2" },
  };
  assert.equal(isManagedProject(wordpress), true);
  assert.equal(shouldShowCardUpgradeNotice(wordpress), false);

  const dokuwikiWithRunningAutoMigration = {
    id: "wiki",
    name: "Wiki",
    recipe: { name: "@zelavis/dokuwiki", version: "1.0.0", managed: { adminTitle: "Wiki Admin" } },
    capabilities: { recipeUpdateMode: "integration" },
    recipeStatus: { state: "current" },
    dataLayout: { state: "upgradeRequired", from: 2, to: 5, autoMigration: { state: "running" } },
  };
  assert.equal(shouldShowCardUpgradeNotice(dokuwikiWithRunningAutoMigration), false);

  const dokuwikiBeforeAutoMigration = {
    ...dokuwikiWithRunningAutoMigration,
    dataLayout: { state: "upgradeRequired", from: 2, to: 5 },
  };
  assert.equal(shouldShowCardUpgradeNotice(dokuwikiBeforeAutoMigration), false);
});

test("managed apps show a /projects card notice only for active upgrades, recovery, or failed auto-migration", () => {
  const base = {
    id: "wp",
    name: "WordPress",
    recipe: { name: "@zelavis/wordpress", version: "1.0.1", managed: { adminTitle: "WordPress Admin" } },
    capabilities: { recipeUpdateMode: "integration" },
    recipeStatus: { state: "current" },
  };
  assert.equal(shouldShowCardUpgradeNotice({ ...base, upgrade: { id: "u1", state: "running", phase: "Migrating data" } }), true);
  assert.equal(shouldShowCardUpgradeNotice({ ...base, upgrade: { id: "u1", state: "failed", error: "boom" } }), true);
  assert.equal(shouldShowCardUpgradeNotice({ ...base, runtimeUpdate: { error: "interrupted" } }), true);
  assert.equal(shouldShowCardUpgradeNotice({
    ...base,
    dataLayout: { state: "upgradeRequired", from: 2, to: 5, autoMigration: { state: "failed", error: "disk full" } },
  }), true);
  assert.equal(shouldShowCardUpgradeNotice({ ...base, deletion: { status: "running" }, upgrade: { id: "u1", state: "failed", error: "boom" } }), false);
});

test("native @zelavis/app Projects still show Upgrade recipe notices on /projects cards", () => {
  const nativeApp = {
    id: "nexus",
    name: "Nexus",
    recipe: { name: "@zelavis/app", version: "2.0.0-alpha.42" },
    capabilities: { recipeUpdateMode: "live", zeroDowntimeUpdates: true },
    recipeStatus: { state: "upgradeAvailable", version: "2.0.0-alpha.47" },
  };
  assert.equal(isManagedProject(nativeApp), false);
  assert.equal(shouldShowCardUpgradeNotice(nativeApp), true);
  assert.equal(shouldShowCardUpgradeNotice({ ...nativeApp, recipeStatus: { state: "current" } }), false);
});

test("upgradeDoneMessage formats migration-only retries clearly", () => {
  const message = upgradeDoneMessage({
    name: "WordPress",
    dataMigration: { from: 2, to: 5, documents: 0, eventsCarried: 0 },
  }, "migration");
  assert.match(message, /WordPress's integration data is up to date/);
  assert.match(message, /format 2 to format 5/);
});
