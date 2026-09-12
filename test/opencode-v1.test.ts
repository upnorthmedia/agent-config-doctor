import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import type { ScanSnapshot } from "../src/core/schema.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { OpenCodeAdapter } from "../src/providers/opencode.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures/opencode/v1", import.meta.url));
const homeDirectory = path.join(fixtureRoot, "home");
const repositoryPath = path.join(fixtureRoot, "repo");

function createContext(
  workingDirectory = repositoryPath,
  environment: Record<string, string> = {},
  executable = "opencode",
): ScanContext {
  return {
    homeDirectory,
    repositoryPath,
    workingDirectory,
    environment,
    executables: { opencode: path.join(fixtureRoot, "bin", executable) },
  };
}

function orderedPaths(snapshot: ScanSnapshot): Array<string | undefined> {
  return snapshot.effective.orderedResourceIds.map(
    (id) =>
      snapshot.effective.resources.find((resource) => resource.id === id)?.displayPath ??
      snapshot.effective.resources.find((resource) => resource.id === id)?.name,
  );
}

function byPath(snapshot: ScanSnapshot, displayPath: string) {
  return snapshot.effective.resources.find((resource) => resource.displayPath === displayPath);
}

test("supports OpenCode 1.18.x exactly", async () => {
  const supported = await new OpenCodeAdapter().detect(createContext());
  assert.equal(supported.version, "1.18.30");
  assert.equal(supported.generation, "v1");
  assert.equal(supported.support, "supported");
  assert.deepEqual(supported.configRoots, [
    path.join(homeDirectory, ".config", "opencode"),
    path.join(repositoryPath, ".opencode"),
  ]);

  const older = await new OpenCodeAdapter().detect(createContext(repositoryPath, {}, "opencode-older"));
  assert.equal(older.version, "1.17.4");
  assert.equal(older.support, "unsupported");
  assert.match(older.supportNote ?? "", /1\.18\.x/);
});

test("loads instructions in the released 1.18 order for root and nested directories", async () => {
  const adapter = new OpenCodeAdapter();
  const root = await scanProvider(adapter, createContext());
  const nested = await scanProvider(adapter, createContext(path.join(repositoryPath, "packages", "api")));

  assert.deepEqual(orderedPaths(root), [
    "$HOME/.config/opencode/AGENTS.md",
    "$REPO/AGENTS.md",
    "$HOME/.config/opencode/global-guide.md",
    "$REPO/docs/guide.md",
    "remote-rules.md",
  ]);
  assert.deepEqual(orderedPaths(nested), [
    "$HOME/.config/opencode/AGENTS.md",
    "$REPO/packages/api/AGENTS.md",
    "$REPO/AGENTS.md",
    "$HOME/.config/opencode/global-guide.md",
    "$REPO/docs/guide.md",
    "remote-rules.md",
  ]);
  assert.equal(byPath(root, "$HOME/.claude/CLAUDE.md")?.state, "shadowed");
  assert.equal(byPath(root, "$REPO/CLAUDE.md")?.state, "shadowed");
  assert.equal(byPath(root, "$REPO/packages/web/AGENTS.md")?.reach, "repository");
  assert.equal(byPath(root, "$REPO/packages/web/AGENTS.md")?.state, "inactive");
  const missing = byPath(root, "$REPO/docs/missing.md");
  assert.equal(missing?.state, "unavailable");
  assert.equal(missing?.findings[0]?.code, "opencode.instruction.missing-reference");
  assert.equal(missing?.findings[0]?.severity, "warning");
  const remote = root.effective.resources.find((resource) => resource.name === "remote-rules.md");
  assert.equal(remote?.evidenceType, "inferred");
  assert.equal(remote?.metadata.remote, true);
  assert.equal(remote?.metadata.url, "https://example.test/remote-rules.md");
});

test("discovers skills from every 1.18 location and keeps the last duplicate", async () => {
  const adapter = new OpenCodeAdapter();
  const root = await scanProvider(adapter, createContext());
  const nested = await scanProvider(adapter, createContext(path.join(repositoryPath, "packages", "api")));
  const skill = (snapshot: ScanSnapshot, name: string) =>
    snapshot.effective.resources.filter((resource) => resource.kind === "skill" && resource.name === name);

  const shared = skill(root, "shared-skill");
  assert.equal(shared.length, 2);
  const winner = shared.find((resource) => resource.state === "active");
  const loser = shared.find((resource) => resource.state === "shadowed");
  assert.equal(winner?.displayPath, "$REPO/.opencode/skills/shared-skill/SKILL.md");
  assert.equal(loser?.displayPath, "$HOME/.agents/skills/shared-skill/SKILL.md");
  assert.equal(loser?.findings[0]?.code, "opencode.skill.duplicate-name");
  assert.equal(loser?.precedence.shadowedBy, winner?.id);

  assert.equal(skill(root, "global-skill")[0]?.state, "active");
  assert.equal(skill(root, "claude-skill")[0]?.state, "active");
  assert.equal(skill(root, "api-skill")[0]?.state, "inactive");
  assert.equal(skill(root, "api-skill")[0]?.reach, "repository");
  assert.equal(skill(nested, "api-skill")[0]?.state, "active");
  assert.equal(skill(nested, "api-skill")[0]?.reach, "chain");
  assert.equal(skill(root, "web-skill")[0]?.state, "inactive");
  assert.equal(skill(root, "web-skill")[0]?.reach, "repository");
  const undescribed = skill(root, "undescribed")[0];
  assert.equal(undescribed?.state, "inactive");
  assert.equal(undescribed?.findings[0]?.code, "opencode.skill.missing-description");
  const builtin = skill(root, "customize-opencode")[0];
  assert.equal(builtin?.state, "active");
  assert.deepEqual(builtin?.owner, { type: "provider", id: "opencode" });
  assert.equal(builtin?.generated, true);
  assert.equal(builtin?.path, undefined);
});

test("discovers configured and directory plugins with missing references and dedupe", async () => {
  const snapshot = await scanProvider(new OpenCodeAdapter(), createContext());
  const plugins = snapshot.effective.resources.filter((resource) => resource.kind === "plugin");
  const named = (name: string) => plugins.filter((resource) => resource.name === name);

  const cached = named("cached-plugin");
  assert.equal(cached.length, 2);
  assert.equal(cached.find((resource) => resource.state === "active")?.displayPath, "$REPO/opencode.json");
  assert.equal(cached.find((resource) => resource.state === "shadowed")?.displayPath, "$HOME/.config/opencode/opencode.json");
  assert.ok(cached.every((resource) => resource.metadata.installed === true));
  assert.deepEqual(cached[0]?.owner, { type: "package", id: "cached-plugin" });
  assert.equal(named("uncached-plugin")[0]?.metadata.installed, false);
  assert.equal(named("local-plugin.js")[0]?.state, "active");
  assert.equal(named("local-plugin.js")[0]?.displayPath, "$REPO/plugins/local-plugin.js");
  const missing = named("missing-plugin.js")[0];
  assert.equal(missing?.state, "unavailable");
  assert.equal(missing?.findings[0]?.code, "opencode.plugin.missing-reference");
  assert.equal(named("directory-plugin.ts")[0]?.origin, "opencode-plugin-directory");
  assert.equal(named("directory-plugin.ts")[0]?.scope, "project");
  assert.equal(named("global-plugin.js")[0]?.origin, "opencode-plugin-directory");
  assert.equal(named("global-plugin.js")[0]?.scope, "user");
});

test("merges MCP servers across configuration sources and honors enabled=false", async () => {
  const adapter = new OpenCodeAdapter();
  const root = await scanProvider(adapter, createContext());
  const nested = await scanProvider(adapter, createContext(path.join(repositoryPath, "packages", "api")));
  const servers = (snapshot: ScanSnapshot, name: string) =>
    snapshot.effective.resources.filter((resource) => resource.kind === "mcp" && resource.name === name);

  const shared = servers(root, "shared-mcp");
  assert.equal(shared.length, 3);
  const winner = shared.find((resource) => resource.displayPath === "$REPO/.opencode/opencode.jsonc");
  assert.equal(winner?.state, "disabled");
  assert.equal(winner?.metadata.enabled, false);
  assert.equal(winner?.metadata.transportType, "stdio");
  assert.equal(winner?.metadata.command, "node");
  assert.ok(shared.filter((resource) => resource.state === "shadowed").length === 2);
  assert.equal(servers(root, "global-mcp")[0]?.state, "active");
  assert.equal(servers(root, "api-mcp").length, 0);
  assert.equal(servers(nested, "api-mcp")[0]?.state, "active");

  const context = createContext();
  const serialized = JSON.stringify(createScanReport(root, context));
  for (const secret of [
    "fixture-password",
    "fixture-sensitive",
    "fixture-password-provider-key",
    fixtureRoot,
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(serialized.includes("Global skill body"), false);
});

test("honors OpenCode disable flags as disabled paths", async () => {
  const adapter = new OpenCodeAdapter();
  const noProject = await scanProvider(
    adapter,
    createContext(repositoryPath, { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }),
  );
  assert.deepEqual(orderedPaths(noProject), [
    "$HOME/.config/opencode/AGENTS.md",
    "$HOME/.config/opencode/global-guide.md",
  ]);
  assert.equal(byPath(noProject, "$REPO/AGENTS.md")?.state, "disabled");
  assert.equal(byPath(noProject, "$REPO/AGENTS.md")?.metadata.disabledBy, "OPENCODE_DISABLE_PROJECT_CONFIG");
  assert.equal(
    noProject.effective.resources.find((resource) => resource.name === "directory-plugin.ts")?.state,
    "disabled",
  );
  assert.equal(
    noProject.effective.resources.find(
      (resource) => resource.kind === "mcp" && resource.displayPath === "$REPO/opencode.json",
    )?.state,
    "disabled",
  );

  const noClaude = await scanProvider(
    adapter,
    createContext(repositoryPath, { OPENCODE_DISABLE_CLAUDE_CODE: "true" }),
  );
  assert.equal(byPath(noClaude, "$HOME/.claude/CLAUDE.md")?.state, "disabled");
  assert.equal(byPath(noClaude, "$REPO/CLAUDE.md")?.state, "disabled");
  assert.equal(byPath(noClaude, "$HOME/.claude/skills/claude-skill/SKILL.md")?.state, "disabled");
  assert.equal(byPath(noClaude, "$HOME/.agents/skills/shared-skill/SKILL.md")?.state, "shadowed");
});
