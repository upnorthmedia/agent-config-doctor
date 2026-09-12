import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { scanProviders } from "../src/core/coordinator.ts";
import type { ScanContext } from "../src/core/provider-adapter.ts";
import { scanProvider } from "../src/core/scanner.ts";
import { ClaudeAdapter } from "../src/providers/claude.ts";
import { CodexAdapter } from "../src/providers/codex.ts";
import { GrokAdapter } from "../src/providers/grok.ts";
import { HermesAdapter } from "../src/providers/hermes.ts";
import { OpenCodeAdapter } from "../src/providers/opencode.ts";
import {
  GENERATED_DIRECTORY_NAMES,
  findNamedFiles,
  reachForDirectory,
} from "../src/providers/shared.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const codexFixture = path.join(repositoryRoot, "test", "fixtures", "codex", "instruction-chain");
const claudeFixture = path.join(repositoryRoot, "test", "fixtures", "claude", "provider");
const hermesFixture = path.join(repositoryRoot, "test", "fixtures", "hermes", "provider");
const grokFixture = path.join(repositoryRoot, "test", "fixtures", "grok", "provider");
const opencodeFixture = path.join(repositoryRoot, "test", "fixtures", "opencode", "provider");

async function selfScanContext(
  t: TestContext,
  workingDirectory = repositoryRoot,
): Promise<ScanContext> {
  // The home directory lives outside the repository so every fixture home is
  // discovered the way a real self-scan discovers it: through the repository walk.
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-config-self-home-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  return {
    homeDirectory,
    repositoryPath: repositoryRoot,
    workingDirectory,
    environment: {
      CODEX_HOME: path.join(homeDirectory, ".codex"),
      HERMES_HOME: path.join(homeDirectory, ".hermes"),
      HERMES_FIXTURE_EXTERNAL: path.join(hermesFixture, "external", "skills"),
    },
    executables: {
      claude: path.join(claudeFixture, "bin", "claude"),
      codex: path.join(codexFixture, "bin", "codex"),
      grok: path.join(grokFixture, "bin", "grok"),
      opencode: path.join(opencodeFixture, "bin", "opencode-legacy"),
      hermes: path.join(hermesFixture, "bin", "hermes"),
    },
    adminRoots: {
      claude: path.join(claudeFixture, "admin", "claude"),
      codex: path.join(codexFixture, "admin", "codex"),
    },
  };
}

test("scanning this repository keeps fixture resources out of the effective chain", async (t) => {
  const adapters = [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new GrokAdapter(),
    new OpenCodeAdapter(),
    new HermesAdapter(),
  ];
  const scan = await scanProviders(adapters, await selfScanContext(t));
  // Fixture executables natively report plugins that live inside the fixture
  // trees. Native listings are authoritative wherever their files live, so the
  // gate covers everything the repository walk discovered on its own.
  const fixtureResources = scan.report.resources.filter(
    (resource) =>
      resource.displayPath?.startsWith("$REPO/test/fixtures/") &&
      resource.evidenceType !== "native" &&
      resource.owner.type !== "plugin",
  );
  const effectiveIds = new Set(
    Object.values(scan.report.effective).flatMap((effective) => [
      ...effective.orderedResourceIds,
      ...effective.decisions.map((decision) => decision.resourceId),
    ]),
  );

  assert.ok(fixtureResources.length > 0, "fixtures stay visible in inventory");
  for (const resource of fixtureResources) {
    assert.equal(resource.reach, "repository", resource.displayPath);
    assert.notEqual(resource.state, "active", resource.displayPath);
    assert.equal(effectiveIds.has(resource.id), false, resource.displayPath);
  }
  assert.ok(
    scan.report.resources.some(
      (resource) => resource.reach === "chain" && resource.state === "active",
    ),
  );
  for (const resource of scan.report.resources) {
    assert.ok(
      resource.reach === "chain" || resource.reach === "repository",
      `${resource.displayPath ?? resource.name} has no reach`,
    );
  }
});

test("findings on fixture resources keep their severity but never count as in-context errors", async (t) => {
  const adapters = [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new GrokAdapter(),
    new OpenCodeAdapter(),
    new HermesAdapter(),
  ];
  const scan = await scanProviders(adapters, await selfScanContext(t));
  const byId = new Map(scan.report.resources.map((resource) => [resource.id, resource]));
  const brokenImport = scan.report.findings.find(
    (finding) =>
      finding.code === "claude.instruction.broken-import" &&
      byId.get(finding.resourceId ?? "")?.displayPath ===
        "$REPO/test/fixtures/claude/provider/repo/missing-instructions.md",
  );

  assert.ok(brokenImport, "the fixture broken import is still reported");
  assert.equal(brokenImport.severity, "error");
  assert.equal(brokenImport.reach, "repository");
  const inContextErrors = scan.report.findings.filter(
    (finding) => finding.reach !== "repository" && finding.severity === "error",
  );
  assert.deepEqual(inContextErrors, []);
});

test("nested synthetic homes stay visible as repository inventory instead of being hidden", async (t) => {
  const snapshot = await scanProvider(new CodexAdapter(), await selfScanContext(t));
  const nestedHomeInstruction = snapshot.effective.resources.find(
    (resource) =>
      resource.displayPath ===
      "$REPO/test/fixtures/codex/instruction-chain/home/.codex/AGENTS.md",
  );

  assert.ok(nestedHomeInstruction, "nested home instruction is discovered");
  assert.equal(nestedHomeInstruction.reach, "repository");
  assert.equal(nestedHomeInstruction.state, "inactive");
});

test("walker skips generated directories and reports the ancestor chain", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-config-walker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = ["node_modules/dep", "dist", "build", "coverage", ".venv", "__pycache__", ".git/info"];
  for (const directory of [...generated, "packages/api", "packages/web"]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, "AGENTS.md"), "# nested\n", "utf8");
  }
  await writeFile(path.join(root, "AGENTS.md"), "# root\n", "utf8");

  const found = await findNamedFiles(root, new Set(["AGENTS.md"]));

  assert.deepEqual(found, [
    path.join(root, "AGENTS.md"),
    path.join(root, "packages", "api", "AGENTS.md"),
    path.join(root, "packages", "web", "AGENTS.md"),
  ]);
  assert.ok(GENERATED_DIRECTORY_NAMES.has("node_modules"));
  assert.ok(GENERATED_DIRECTORY_NAMES.has(".git"));
  const context: ScanContext = {
    homeDirectory: os.homedir(),
    repositoryPath: root,
    workingDirectory: path.join(root, "packages", "api"),
    environment: {},
  };
  assert.equal(reachForDirectory(root, context), "chain");
  assert.equal(reachForDirectory(path.join(root, "packages", "api"), context), "chain");
  assert.equal(reachForDirectory(path.join(root, "packages", "web"), context), "repository");
  assert.equal(reachForDirectory(os.homedir(), context), "chain");
});

test("a working directory under a generated directory name keeps its chain files effective", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-config-build-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = path.join(root, "build", "tools");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(path.join(root, "build", "output"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# root\n", "utf8");
  await writeFile(path.join(workingDirectory, "AGENTS.md"), "# tools\n", "utf8");
  await writeFile(path.join(workingDirectory, "CLAUDE.md"), "# tools\n", "utf8");
  await writeFile(path.join(root, "build", "output", "AGENTS.md"), "# generated\n", "utf8");
  await writeFile(path.join(root, "build", "output", "CLAUDE.md"), "# generated\n", "utf8");
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-config-build-home-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const context: ScanContext = {
    homeDirectory,
    repositoryPath: root,
    workingDirectory,
    environment: { CODEX_HOME: path.join(homeDirectory, ".codex") },
    executables: {
      claude: path.join(claudeFixture, "bin", "claude"),
      codex: path.join(codexFixture, "bin", "codex"),
    },
  };

  const codex = await scanProvider(new CodexAdapter(), context);
  const claude = await scanProvider(new ClaudeAdapter(), context);
  const orderedPaths = (snapshot: typeof codex) =>
    snapshot.effective.orderedResourceIds.map(
      (id) => snapshot.effective.resources.find((resource) => resource.id === id)?.displayPath,
    );

  assert.deepEqual(orderedPaths(codex), ["$REPO/AGENTS.md", "$REPO/build/tools/AGENTS.md"]);
  assert.ok(orderedPaths(claude).includes("$REPO/build/tools/CLAUDE.md"));
  for (const [snapshot, siblingPath] of [
    [codex, "$REPO/build/output/AGENTS.md"],
    [claude, "$REPO/build/output/CLAUDE.md"],
  ] as const) {
    const sibling = snapshot.effective.resources.find(
      (resource) => resource.displayPath === siblingPath,
    );
    assert.ok(sibling, `${siblingPath} stays visible as inventory`);
    assert.equal(sibling.reach, "repository");
    assert.notEqual(sibling.state, "active");
    assert.equal(snapshot.effective.orderedResourceIds.includes(sibling.id), false);
    for (const resource of snapshot.effective.resources) {
      if (resource.displayPath?.startsWith("$REPO/build/tools/")) {
        assert.equal(resource.reach, "chain", resource.displayPath);
        assert.equal(resource.state, "active", resource.displayPath);
      }
    }
  }
  assert.deepEqual(codex.notices, []);
  assert.deepEqual(claude.notices, []);
});

test("a working directory literally named build keeps its own project skills active", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-config-build-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = path.join(root, "build");
  const skill = "---\nname: deploy\ndescription: Deploy the build.\n---\n\nDeploy.\n";
  for (const directory of [
    path.join(workingDirectory, ".claude", "skills", "deploy"),
    path.join(workingDirectory, ".agents", "skills", "deploy"),
    path.join(root, "dist", ".claude", "skills", "stale"),
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), skill, "utf8");
  }
  await writeFile(path.join(root, "AGENTS.md"), "# root\n", "utf8");
  await writeFile(path.join(workingDirectory, "AGENTS.md"), "# build\n", "utf8");
  await writeFile(path.join(workingDirectory, "CLAUDE.md"), "# build\n", "utf8");
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-config-build-skills-home-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const context: ScanContext = {
    homeDirectory,
    repositoryPath: root,
    workingDirectory,
    environment: { CODEX_HOME: path.join(homeDirectory, ".codex") },
    executables: {
      claude: path.join(claudeFixture, "bin", "claude"),
      codex: path.join(codexFixture, "bin", "codex"),
    },
  };

  const expectations = [
    {
      adapter: new ClaudeAdapter(),
      skillPath: "$REPO/build/.claude/skills/deploy/SKILL.md",
      instructionPath: "$REPO/build/CLAUDE.md",
    },
    {
      adapter: new CodexAdapter(),
      skillPath: "$REPO/build/.agents/skills/deploy/SKILL.md",
      instructionPath: "$REPO/build/AGENTS.md",
    },
  ];
  for (const { adapter, skillPath, instructionPath } of expectations) {
    const snapshot = await scanProvider(adapter, context);
    const deploy = snapshot.effective.resources.find(
      (resource) => resource.displayPath === skillPath,
    );
    assert.ok(deploy, `${adapter.provider} discovers ${skillPath}`);
    assert.equal(deploy.kind, "skill");
    assert.equal(deploy.reach, "chain");
    assert.equal(deploy.state, "active");
    const instruction = snapshot.effective.resources.find(
      (resource) => resource.displayPath === instructionPath,
    );
    assert.ok(instruction, `${adapter.provider} discovers ${instructionPath}`);
    assert.equal(instruction.reach, "chain");
    assert.equal(instruction.state, "active");
    assert.ok(snapshot.effective.orderedResourceIds.includes(instruction.id));
    assert.equal(
      snapshot.effective.resources.some((resource) => resource.displayPath?.startsWith("$REPO/dist/")),
      false,
      `${adapter.provider} still skips off-chain generated directories`,
    );
    assert.deepEqual(snapshot.notices, []);
  }
});

test("discovers Codex system skills as provider-owned resources", async () => {
  const context: ScanContext = {
    homeDirectory: path.join(codexFixture, "home"),
    repositoryPath: path.join(codexFixture, "repo"),
    workingDirectory: path.join(codexFixture, "repo"),
    environment: { CODEX_HOME: path.join(codexFixture, "home", ".codex") },
    executables: { codex: path.join(codexFixture, "bin", "codex") },
  };
  const snapshot = await scanProvider(new CodexAdapter(), context);
  const systemSkill = snapshot.effective.resources.find(
    (resource) =>
      resource.displayPath === "$CODEX_HOME/skills/.system/system-skill/SKILL.md",
  );

  assert.ok(systemSkill, "system skill is discovered");
  assert.equal(systemSkill.kind, "skill");
  assert.equal(systemSkill.origin, "codex-system");
  assert.equal(systemSkill.scope, "bundled");
  assert.deepEqual(systemSkill.owner, { type: "provider", id: "codex" });
  assert.equal(systemSkill.state, "active");
  assert.equal(systemSkill.reach, "chain");
});
