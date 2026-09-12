import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { CodexAdapter } from "../src/providers/codex.ts";
import { GrokAdapter } from "../src/providers/grok.ts";
import { HermesAdapter } from "../src/providers/hermes.ts";

const testRoot = fileURLToPath(new URL(".", import.meta.url));
const codexFixture = path.join(testRoot, "fixtures", "codex", "instruction-chain");
const grokFixture = path.join(testRoot, "fixtures", "grok", "provider");
const hermesFixture = path.join(testRoot, "fixtures", "hermes", "provider");

function codexContext(): ScanContext {
  return {
    homeDirectory: path.join(codexFixture, "home"),
    repositoryPath: path.join(codexFixture, "repo"),
    workingDirectory: path.join(codexFixture, "repo", "packages", "api", "src"),
    environment: { CODEX_HOME: path.join(codexFixture, "home", ".codex") },
    executables: { codex: path.join(codexFixture, "bin", "codex") },
  };
}

test("name-directory mismatch is a warning for user skills and informational for managed skills", async () => {
  const context = codexContext();
  const report = createScanReport(await scanProvider(new CodexAdapter(), context), context);
  const userSkill = report.resources.find(
    (resource) => resource.displayPath?.endsWith("mismatched-directory/SKILL.md"),
  );
  const pluginSkill = report.resources.find(
    (resource) => resource.displayPath?.endsWith("plugin-mismatch/SKILL.md"),
  );
  const userFinding = report.findings.find((finding) => finding.resourceId === userSkill?.id);
  const pluginFinding = report.findings.find((finding) => finding.resourceId === pluginSkill?.id);

  assert.ok(userSkill && pluginSkill);
  assert.equal(userFinding?.code, "codex.skill.name-directory-mismatch");
  assert.equal(userFinding?.severity, "warning");
  assert.equal(userFinding?.confidence, "medium");
  assert.equal(userSkill.state, "active");
  assert.equal(pluginFinding?.code, "codex.skill.name-directory-mismatch");
  assert.equal(pluginFinding?.severity, "info");
  assert.equal(pluginSkill.state, "active");
  assert.equal(report.findings.some((finding) => finding.severity === "error"), false);
});

test("Codex marketplace plugins and system skills are provider-managed generated resources", async () => {
  const context = codexContext();
  const report = createScanReport(await scanProvider(new CodexAdapter(), context), context);
  const plugin = report.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "fixture-plugin",
  );
  const pluginSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "plugin-skill",
  );
  const systemSkill = report.resources.find(
    (resource) => resource.origin === "codex-system",
  );
  const userSkill = report.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "root-skill",
  );

  assert.deepEqual(plugin?.owner, { type: "provider", id: "codex" });
  assert.equal(plugin?.generated, true);
  assert.equal(plugin?.loadMode, "explicitly-enabled");
  assert.deepEqual(pluginSkill?.owner, { type: "plugin", id: "fixture-plugin@test-market" });
  assert.equal(pluginSkill?.generated, true);
  assert.equal(pluginSkill?.loadMode, "on-demand");
  assert.equal(systemSkill?.generated, true);
  assert.deepEqual(userSkill?.owner, { type: "self" });
  assert.equal(userSkill?.generated, undefined);
  for (const resource of report.resources) {
    const expected: Record<string, string | undefined> = {
      instruction: "context-loaded",
      skill: "on-demand",
      plugin: "explicitly-enabled",
      mcp: "explicitly-enabled",
    };
    assert.equal(resource.loadMode, expected[resource.kind], resource.displayPath);
    assert.ok(resource.reach === "chain" || resource.reach === "repository");
  }
});

test("Grok bundled skills and Hermes bundled skills are provider-owned", async () => {
  const grokContext: ScanContext = {
    homeDirectory: path.join(grokFixture, "home"),
    repositoryPath: path.join(grokFixture, "repo"),
    workingDirectory: path.join(grokFixture, "repo"),
    environment: {},
    executables: { grok: path.join(grokFixture, "bin", "grok") },
  };
  const grokReport = createScanReport(
    await scanProvider(new GrokAdapter(), grokContext),
    grokContext,
  );
  const grokBundled = grokReport.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "bundled-skill",
  );
  assert.deepEqual(grokBundled?.owner, { type: "provider", id: "grok" });
  assert.equal(grokBundled?.scope, "bundled");
  assert.equal(grokBundled?.generated, true);
  assert.equal(grokBundled?.state, "active");

  const hermesContext: ScanContext = {
    homeDirectory: path.join(hermesFixture, "home"),
    repositoryPath: path.join(hermesFixture, "repo"),
    workingDirectory: path.join(hermesFixture, "repo"),
    environment: {
      HERMES_HOME: path.join(hermesFixture, "home", ".hermes"),
      HERMES_FIXTURE_EXTERNAL: path.join(hermesFixture, "external", "skills"),
    },
    executables: { hermes: path.join(hermesFixture, "bin", "hermes") },
  };
  const hermesReport = createScanReport(
    await scanProvider(new HermesAdapter(), hermesContext),
    hermesContext,
  );
  const bundled = hermesReport.resources.find((resource) => resource.name === "bundled-skill");
  const protectedSkill = hermesReport.resources.find(
    (resource) => resource.name === "protected-skill",
  );
  const local = hermesReport.resources.find((resource) => resource.name === "shared-skill" && resource.origin === "hermes-local");
  assert.deepEqual(bundled?.owner, { type: "provider", id: "hermes" });
  assert.equal(bundled?.generated, true);
  assert.deepEqual(protectedSkill?.owner, { type: "provider", id: "hermes" });
  assert.equal(protectedSkill?.generated, undefined);
  assert.equal(protectedSkill?.state, "active");
  assert.deepEqual(local?.owner, { type: "self" });
});
