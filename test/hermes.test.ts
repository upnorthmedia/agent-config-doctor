import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { HermesAdapter } from "../src/providers/hermes.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/hermes/provider", import.meta.url),
);
const repositoryPath = path.join(fixtureRoot, "repo");
const hermesHome = path.join(fixtureRoot, "home", ".hermes");
const externalSkills = path.join(fixtureRoot, "external", "skills");

function createContext(workingDirectory = repositoryPath): ScanContext {
  return {
    homeDirectory: path.join(fixtureRoot, "home"),
    repositoryPath,
    workingDirectory,
    environment: {
      HERMES_HOME: hermesHome,
      HERMES_FIXTURE_EXTERNAL: externalSkills,
    },
    executables: {
      hermes: path.join(fixtureRoot, "bin", "hermes"),
    },
  };
}

test("detects Hermes and its configured roots", async () => {
  const detection = await new HermesAdapter().detect(createContext());

  assert.equal(detection.installed, true);
  assert.equal(detection.version, "0.12.0");
  assert.equal(detection.support, "supported");
  assert.deepEqual(detection.configRoots, [
    hermesHome,
    path.join(repositoryPath, ".hermes"),
  ]);
});

test("resolves Hermes context priority for root and nested workspaces", async () => {
  const adapter = new HermesAdapter();
  const rootSnapshot = await scanProvider(adapter, createContext());
  const nestedContext = createContext(
    path.join(repositoryPath, "packages", "api", "src"),
  );
  const nestedSnapshot = await scanProvider(adapter, nestedContext);
  const paths = (snapshot: typeof rootSnapshot) =>
    snapshot.effective.orderedResourceIds.map(
      (id) => snapshot.effective.resources.find((resource) => resource.id === id)?.displayPath,
    );

  assert.deepEqual(paths(rootSnapshot), [
    "$HERMES_HOME/SOUL.md",
    "$REPO/AGENTS.md",
  ]);
  assert.deepEqual(paths(nestedSnapshot), [
    "$HERMES_HOME/SOUL.md",
    "$REPO/packages/api/.hermes.md",
  ]);
  assert.equal(
    nestedSnapshot.effective.resources.find(
      (resource) => resource.displayPath === "$REPO/AGENTS.md",
    )?.state,
    "inactive",
  );
  assert.equal(
    nestedSnapshot.effective.resources.find(
      (resource) => resource.displayPath === "$REPO/packages/web/HERMES.md",
    )?.state,
    "inactive",
  );
});

test("preserves Hermes skill origins, plugin boundaries, MCP allowlists, and redaction", async () => {
  const context = createContext(
    path.join(repositoryPath, "packages", "api", "src"),
  );
  const report = createScanReport(
    await scanProvider(new HermesAdapter(), context),
    context,
  );
  const sharedSkills = report.resources.filter(
    (resource) => resource.kind === "skill" && resource.name === "shared-skill",
  );
  const bundledSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "bundled-skill",
  );
  const protectedSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "protected-skill",
  );
  const hubSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "hub-skill",
  );
  const pluginSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "enabled-plugin:plugin-skill",
  );
  const enabledPlugin = report.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "enabled-plugin",
  );
  const disabledPlugin = report.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "disabled-plugin",
  );
  const waitingPlugin = report.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "waiting-plugin",
  );
  const blockedPlugin = report.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "project-plugin",
  );
  const activeMcp = report.resources.find(
    (resource) => resource.kind === "mcp" && resource.name === "fixture-mcp",
  );
  const disabledMcp = report.resources.find(
    (resource) => resource.kind === "mcp" && resource.name === "disabled-mcp",
  );

  assert.equal(sharedSkills.filter((resource) => resource.state === "active").length, 1);
  assert.equal(
    sharedSkills.find((resource) => resource.state === "active")?.origin,
    "hermes-local",
  );
  assert.equal(
    sharedSkills.find((resource) => resource.origin === "hermes-external")?.state,
    "shadowed",
  );
  assert.equal(bundledSkill?.origin, "hermes-bundled");
  assert.equal(bundledSkill?.metadata.syncProtection, "upstream-managed");
  assert.equal(protectedSkill?.origin, "hermes-bundled-protected");
  assert.equal(protectedSkill?.state, "active");
  assert.equal(protectedSkill?.metadata.syncProtection, "user-modified");
  assert.equal(hubSkill?.origin, "hermes-hub");
  assert.equal(hubSkill?.metadata.pruningEligible, false);
  assert.deepEqual(pluginSkill?.owner, { type: "plugin", id: "enabled-plugin" });
  assert.equal(pluginSkill?.state, "active");
  assert.equal(enabledPlugin?.state, "active");
  assert.deepEqual(enabledPlugin?.metadata.mcpAllowlist, ["fixture-mcp"]);
  assert.equal(disabledPlugin?.state, "disabled");
  assert.equal(waitingPlugin?.state, "inactive");
  assert.equal(blockedPlugin?.state, "blocked");
  assert.equal(activeMcp?.state, "active");
  assert.equal(disabledMcp?.state, "disabled");
  assert.ok(
    report.resources.every(
      (resource) => resource.evidenceType && resource.evidenceReceipt.length > 0,
    ),
  );

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(fixtureRoot), false);
  assert.equal(serialized.includes("fixture-sensitive"), false);
  assert.equal(serialized.includes("fixture-password"), false);
});
