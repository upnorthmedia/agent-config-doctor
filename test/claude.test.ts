import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { ClaudeAdapter } from "../src/providers/claude.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/claude/provider", import.meta.url),
);
const repositoryPath = path.join(fixtureRoot, "repo");

function createContext(workingDirectory = repositoryPath): ScanContext {
  return {
    homeDirectory: path.join(fixtureRoot, "home"),
    repositoryPath,
    workingDirectory,
    environment: {},
    executables: {
      claude: path.join(fixtureRoot, "bin", "claude"),
    },
    adminRoots: {
      claude: path.join(fixtureRoot, "admin", "claude"),
    },
  };
}

test("detects Claude Code and its managed, user, and project roots", async () => {
  const detection = await new ClaudeAdapter().detect(createContext());

  assert.equal(detection.installed, true);
  assert.equal(detection.version, "2.1.268");
  assert.equal(detection.support, "supported");
  assert.deepEqual(detection.configRoots, [
    path.join(fixtureRoot, "admin", "claude"),
    path.join(fixtureRoot, "home", ".claude"),
    path.join(repositoryPath, ".claude"),
  ]);
});

test("resolves Claude instructions and imports for root and nested workspaces", async () => {
  const adapter = new ClaudeAdapter();
  const rootSnapshot = await scanProvider(adapter, createContext());
  const nestedContext = createContext(path.join(repositoryPath, "packages", "api"));
  const nestedSnapshot = await scanProvider(adapter, nestedContext);

  const rootPaths = rootSnapshot.effective.orderedResourceIds.map(
    (id) => rootSnapshot.effective.resources.find((resource) => resource.id === id)?.displayPath,
  );
  const nestedPaths = nestedSnapshot.effective.orderedResourceIds.map(
    (id) => nestedSnapshot.effective.resources.find((resource) => resource.id === id)?.displayPath,
  );

  assert.deepEqual(rootPaths, [
    "$ADMIN/CLAUDE.md",
    "$HOME/.claude/CLAUDE.md",
    "$REPO/CLAUDE.md",
    "$REPO/AGENTS.md",
    "$REPO/CLAUDE.local.md",
  ]);
  assert.deepEqual(nestedPaths, [
    ...rootPaths,
    "$REPO/packages/api/CLAUDE.md",
    "$REPO/packages/api/guide.md",
  ]);
  assert.equal(
    nestedSnapshot.effective.resources.find(
      (resource) => resource.displayPath === "$REPO/packages/web/CLAUDE.md",
    )?.state,
    "inactive",
  );
  assert.equal(
    nestedSnapshot.effective.resources.find(
      (resource) => resource.displayPath === "$REPO/AGENTS.md",
    )?.metadata.canonicalAgentsPointer,
    true,
  );
  assert.ok(
    nestedSnapshot.findings.some(
      (finding) => finding.code === "claude.instruction.broken-import",
    ),
  );
});

test("preserves Claude skill precedence, plugin ownership, scopes, and redaction", async () => {
  const context = createContext(path.join(repositoryPath, "packages", "api"));
  const report = createScanReport(
    await scanProvider(new ClaudeAdapter(), context),
    context,
  );
  const sharedSkills = report.resources.filter(
    (resource) => resource.kind === "skill" && resource.name === "shared-skill",
  );
  const pluginSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "plugin-skill",
  );
  const pluginMcp = report.resources.find(
    (resource) => resource.kind === "mcp" && resource.name === "fixture-plugin-mcp",
  );
  const fixturePlugins = report.resources.filter(
    (resource) => resource.kind === "plugin" && resource.name === "fixture-plugin",
  );
  const fixturePluginSkills = report.resources.filter(
    (resource) => resource.kind === "skill" && resource.name === "plugin-skill",
  );
  const fixturePluginMcps = report.resources.filter(
    (resource) => resource.kind === "mcp" && resource.name === "fixture-plugin-mcp",
  );
  const managedPlugin = report.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "managed-plugin",
  );

  assert.equal(sharedSkills.filter((resource) => resource.state === "active").length, 1);
  assert.equal(
    sharedSkills.find((resource) => resource.state === "active")?.scope,
    "managed",
  );
  assert.deepEqual(pluginSkill?.owner, {
    type: "plugin",
    id: "fixture-plugin@test-market",
  });
  assert.deepEqual(pluginMcp?.owner, {
    type: "plugin",
    id: "fixture-plugin@test-market",
  });
  assert.equal(fixturePlugins.length, 2);
  assert.equal(
    fixturePlugins.find((resource) => resource.state === "active")?.scope,
    "local",
  );
  assert.equal(
    fixturePlugins.find((resource) => resource.scope === "user")?.state,
    "shadowed",
  );
  assert.deepEqual(
    fixturePluginSkills.map((resource) => resource.state).sort(),
    ["active", "shadowed"],
  );
  assert.deepEqual(
    fixturePluginMcps.map((resource) => resource.state).sort(),
    ["active", "shadowed"],
  );
  assert.equal(managedPlugin?.scope, "managed");
  assert.equal(managedPlugin?.state, "disabled");
  assert.deepEqual(
    report.resources.find(
      (resource) => resource.kind === "plugin" && resource.name === "fixture-plugin",
    )?.metadata.dependencies,
    ["base@test-market"],
  );
  assert.ok(
    report.resources.every(
      (resource) => resource.evidenceReceipt.length > 0 && resource.evidenceType,
    ),
  );

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(fixtureRoot), false);
  assert.equal(serialized.includes("fixture-sensitive"), false);
  assert.equal(serialized.includes("fixture-password"), false);
});
