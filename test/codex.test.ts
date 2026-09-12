import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CodexAdapter } from "../src/providers/codex.ts";
import type { ScanContext } from "../src/core/provider-adapter.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/codex/instruction-chain", import.meta.url),
);

function createContext(): ScanContext {
  const homeDirectory = path.join(fixtureRoot, "home");
  const repositoryPath = path.join(fixtureRoot, "repo");

  return {
    homeDirectory,
    repositoryPath,
    workingDirectory: path.join(repositoryPath, "packages", "api", "src"),
    environment: {
      CODEX_HOME: path.join(homeDirectory, ".codex"),
    },
    executables: {
      codex: path.join(fixtureRoot, "bin", "codex"),
    },
    adminRoots: {
      codex: path.join(fixtureRoot, "admin", "codex"),
    },
  };
}

test("detects the Codex version and configuration roots", async () => {
  const context = createContext();
  const detection = await new CodexAdapter().detect(context);

  assert.equal(detection.installed, true);
  assert.equal(detection.version, "0.117.0-alpha.15");
  assert.equal(detection.support, "supported");
  assert.deepEqual(detection.configRoots, [
    path.join(context.homeDirectory, ".codex"),
    path.join(context.repositoryPath, ".codex"),
  ]);
});

test("reports Codex as unavailable when the executable is missing", async () => {
  const context = createContext();
  const detection = await new CodexAdapter().detect({
    ...context,
    executables: {
      codex: path.join(fixtureRoot, "bin", "missing-codex"),
    },
  });

  assert.equal(detection.installed, false);
  assert.equal(detection.version, "unknown");
  assert.equal(detection.support, "unavailable");
});

test("reports an unrecognized Codex version without guessing", async () => {
  const context = createContext();
  const detection = await new CodexAdapter().detect({
    ...context,
    executables: {
      codex: path.join(fixtureRoot, "bin", "codex-unknown"),
    },
  });

  assert.equal(detection.installed, true);
  assert.equal(detection.version, "unknown");
  assert.equal(detection.support, "unsupported");
});

test("resolves the Codex instruction chain at the repository root", async () => {
  const adapter = new CodexAdapter();
  const baseContext = createContext();
  const context = {
    ...baseContext,
    workingDirectory: baseContext.repositoryPath,
  };
  const detection = await adapter.detect(context);
  const { resources: installed } = await adapter.discover(context, detection);
  const effective = await adapter.resolveEffective(context, installed, detection);
  const byId = new Map(
    effective.resources.map((resource) => [resource.id, resource.displayPath]),
  );

  assert.deepEqual(
    effective.orderedResourceIds.map((id) => byId.get(id)),
    ["$CODEX_HOME/AGENTS.md", "$REPO/AGENTS.md"],
  );
});

test("distinguishes installed instructions from the effective nested chain", async () => {
  const adapter = new CodexAdapter();
  const context = createContext();
  const detection = await adapter.detect(context);
  const { resources: installed } = await adapter.discover(context, detection);
  const effective = await adapter.resolveEffective(context, installed, detection);

  const byDisplayPath = new Map(
    effective.resources.map((resource) => [resource.displayPath, resource]),
  );

  assert.equal(effective.provider, "codex");
  assert.equal(effective.providerVersion, "0.117.0-alpha.15");
  assert.deepEqual(effective.orderedResourceIds, [
    byDisplayPath.get("$CODEX_HOME/AGENTS.md")?.id,
    byDisplayPath.get("$REPO/AGENTS.md")?.id,
    byDisplayPath.get("$REPO/packages/api/AGENTS.override.md")?.id,
    byDisplayPath.get("$REPO/packages/api/src/TEAM_GUIDE.md")?.id,
  ]);
  assert.equal(
    byDisplayPath.get("$REPO/packages/api/AGENTS.md")?.state,
    "shadowed",
  );
  assert.equal(
    byDisplayPath.get("$REPO/packages/web/AGENTS.md")?.state,
    "inactive",
  );
  assert.ok(
    effective.resources
      .filter((resource) => resource.kind === "instruction")
      .every(
      (resource) =>
        resource.evidenceType === "parsed" &&
        resource.evidenceReceipt.length > 0,
      ),
  );
});

test("preserves the detected Codex version when no resources are installed", async () => {
  const adapter = new CodexAdapter();
  const context = createContext();
  const detection = await adapter.detect(context);
  const effective = await adapter.resolveEffective(context, [], detection);

  assert.equal(effective.providerVersion, "0.117.0-alpha.15");
  assert.deepEqual(effective.resources, []);
});

test("discovers skills, plugins, and MCP servers with ownership and redaction", async () => {
  const adapter = new CodexAdapter();
  const context = createContext();
  const detection = await adapter.detect(context);
  const { resources: installed } = await adapter.discover(context, detection);
  const effective = await adapter.resolveEffective(context, installed, detection);

  const fixturePlugin = effective.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "fixture-plugin",
  );
  const disabledPlugin = effective.resources.find(
    (resource) => resource.kind === "plugin" && resource.name === "disabled-plugin",
  );
  const pluginSkill = effective.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "plugin-skill",
  );
  const pluginMcp = effective.resources.find(
    (resource) => resource.kind === "mcp" && resource.name === "plugin-fixture-mcp",
  );
  const standaloneMcp = effective.resources.find(
    (resource) => resource.kind === "mcp" && resource.name === "fixture-stdio",
  );
  const disabledMcp = effective.resources.find(
    (resource) =>
      resource.kind === "mcp" && resource.name === "fixture-http-disabled",
  );
  const invalidSkill = effective.resources.find(
    (resource) => resource.displayPath?.endsWith("mismatched-directory/SKILL.md"),
  );
  const siblingSkill = effective.resources.find(
    (resource) => resource.name === "web-skill",
  );

  assert.equal(fixturePlugin?.state, "active");
  assert.equal(fixturePlugin?.evidenceType, "native");
  assert.equal(disabledPlugin?.state, "disabled");
  assert.deepEqual(pluginSkill?.owner, {
    type: "plugin",
    id: "fixture-plugin@test-market",
  });
  assert.equal(pluginSkill?.state, "active");
  assert.deepEqual(pluginMcp?.owner, {
    type: "plugin",
    id: "fixture-plugin@test-market",
  });
  assert.equal(pluginMcp?.state, "active");
  assert.equal(
    effective.resources.filter(
      (resource) =>
        resource.kind === "mcp" && resource.name === "plugin-fixture-mcp",
    ).length,
    1,
  );
  assert.deepEqual(standaloneMcp?.owner, { type: "self" });
  assert.equal(standaloneMcp?.state, "active");
  assert.equal(disabledMcp?.state, "disabled");
  assert.equal(invalidSkill?.state, "active");
  assert.equal(
    invalidSkill?.findings[0]?.code,
    "codex.skill.name-directory-mismatch",
  );
  assert.equal(invalidSkill?.findings[0]?.severity, "warning");
  assert.equal(siblingSkill?.state, "inactive");

  const duplicateSkills = effective.resources.filter(
    (resource) => resource.kind === "skill" && resource.name === "shared-skill",
  );
  assert.equal(duplicateSkills.length, 2);
  assert.deepEqual(
    duplicateSkills.map((resource) => resource.state).sort(),
    ["active", "shadowed"],
  );

  const serialized = JSON.stringify(effective.resources);
  for (const sensitiveValue of [
    "fixture-sensitive-argument",
    "fixture-sensitive-environment-value",
    "fixture-password",
    "fixture-sensitive-query",
    "fixture-sensitive-header-value",
    "fixture-sensitive-plugin-argument",
    "fixture-sensitive-plugin-environment-value",
    "fixture-sensitive-native-plugin-argument",
  ]) {
    assert.equal(serialized.includes(sensitiveValue), false);
  }

  assert.ok(
    effective.resources.every(
      (resource) => resource.evidenceReceipt.length > 0 && resource.evidenceType,
    ),
  );
});
