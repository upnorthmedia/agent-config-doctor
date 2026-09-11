import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { GrokAdapter } from "../src/providers/grok.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/grok/provider", import.meta.url),
);
const repositoryPath = path.join(fixtureRoot, "repo");

function createContext(workingDirectory = repositoryPath): ScanContext {
  return {
    homeDirectory: path.join(fixtureRoot, "home"),
    repositoryPath,
    workingDirectory,
    environment: {},
    executables: {
      grok: path.join(fixtureRoot, "bin", "grok"),
    },
  };
}

test("detects Grok Build and native inspection support", async () => {
  const detection = await new GrokAdapter().detect(createContext());

  assert.equal(detection.installed, true);
  assert.equal(detection.version, "1.0.25");
  assert.equal(detection.support, "supported");
  assert.deepEqual(detection.configRoots, [
    path.join(fixtureRoot, "home", ".grok"),
    path.join(repositoryPath, ".grok"),
  ]);
});

test("uses Grok native instruction order for root and nested workspaces", async () => {
  const adapter = new GrokAdapter();
  const rootSnapshot = await scanProvider(adapter, createContext());
  const nestedContext = createContext(path.join(repositoryPath, "packages", "api"));
  const nestedSnapshot = await scanProvider(adapter, nestedContext);
  const paths = (snapshot: typeof rootSnapshot) =>
    snapshot.effective.orderedResourceIds.map(
      (id) => snapshot.effective.resources.find((resource) => resource.id === id)?.displayPath,
    );

  assert.deepEqual(paths(rootSnapshot), [
    "$HOME/.grok/Agents.md",
    "$REPO/AGENTS.md",
    "$REPO/Claude.md",
  ]);
  assert.deepEqual(paths(nestedSnapshot), [
    "$HOME/.grok/Agents.md",
    "$REPO/AGENTS.md",
    "$REPO/Claude.md",
    "$REPO/packages/api/AGENT.md",
  ]);
  assert.equal(
    nestedSnapshot.effective.resources.find(
      (resource) => resource.displayPath === "$REPO/packages/web/AGENTS.md",
    )?.state,
    "inactive",
  );
  assert.ok(
    nestedSnapshot.findings.some(
      (finding) => finding.code === "grok.instruction.multiple-loaded",
    ),
  );
});

test("preserves Grok compatibility, trust, policy, and plugin ownership", async () => {
  const context = createContext(path.join(repositoryPath, "packages", "api"));
  const report = createScanReport(
    await scanProvider(new GrokAdapter(), context),
    context,
  );
  const compatibilityInstruction = report.resources.find(
    (resource) => resource.displayPath === "$HOME/.claude/Claude.md",
  );
  const blockedPlugin = report.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "project-plugin",
  );
  const blockedMcp = report.resources.find(
    (resource) => resource.kind === "mcp" && resource.name === "blocked-plugin-mcp",
  );
  const pluginSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "plugin-skill",
  );
  const pluginMcp = report.resources.find(
    (resource) => resource.kind === "mcp" && resource.name === "trusted-plugin-mcp",
  );

  assert.equal(compatibilityInstruction?.state, "inactive");
  assert.equal(compatibilityInstruction?.metadata.compatibilityStatus, "disabled");
  assert.equal(blockedPlugin?.state, "blocked");
  assert.equal(blockedMcp?.state, "blocked");
  assert.deepEqual(pluginSkill?.owner, { type: "plugin", id: "trusted-plugin" });
  assert.deepEqual(pluginMcp?.owner, { type: "plugin", id: "trusted-plugin" });
  assert.equal(
    report.resources.filter(
      (resource) => resource.kind === "skill" && resource.name === "shared-skill" && resource.state === "active",
    ).length,
    1,
  );
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
