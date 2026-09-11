import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { OpenCodeAdapter } from "../src/providers/opencode.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/opencode/provider", import.meta.url),
);
const repositoryPath = path.join(fixtureRoot, "repo");

function createContext(
  workingDirectory = repositoryPath,
  executable = "opencode",
): ScanContext {
  return {
    homeDirectory: path.join(fixtureRoot, "home"),
    repositoryPath,
    workingDirectory,
    environment: {},
    executables: {
      opencode: path.join(fixtureRoot, "bin", executable),
    },
  };
}

test("detects OpenCode V2 without applying legacy compatibility rules", async () => {
  const detection = await new OpenCodeAdapter().detect(createContext());

  assert.equal(detection.installed, true);
  assert.equal(detection.version, "2.3.1");
  assert.equal(detection.generation, "v2");
  assert.equal(detection.support, "supported");
  assert.deepEqual(detection.configRoots, [
    path.join(fixtureRoot, "home", ".config", "opencode"),
    path.join(repositoryPath, ".opencode"),
  ]);
});

test("reports legacy OpenCode as installed but unsupported", async () => {
  const adapter = new OpenCodeAdapter();
  const context = createContext(repositoryPath, "opencode-legacy");
  const snapshot = await scanProvider(adapter, context);

  assert.equal(snapshot.detection.installed, true);
  assert.equal(snapshot.detection.version, "1.18.30");
  assert.equal(snapshot.detection.generation, "legacy");
  assert.equal(snapshot.detection.support, "unsupported");
  assert.deepEqual(snapshot.effective.resources, []);
});

test("resolves OpenCode V2 AGENTS files for root and nested workspaces", async () => {
  const adapter = new OpenCodeAdapter();
  const rootSnapshot = await scanProvider(adapter, createContext());
  const nestedContext = createContext(path.join(repositoryPath, "packages", "api"));
  const nestedSnapshot = await scanProvider(adapter, nestedContext);
  const paths = (snapshot: typeof rootSnapshot) =>
    snapshot.effective.orderedResourceIds.map(
      (id) => snapshot.effective.resources.find((resource) => resource.id === id)?.displayPath,
    );

  assert.deepEqual(paths(rootSnapshot), [
    "$HOME/.config/opencode/AGENTS.md",
    "$REPO/AGENTS.md",
  ]);
  assert.deepEqual(paths(nestedSnapshot), [
    "$HOME/.config/opencode/AGENTS.md",
    "$REPO/packages/api/AGENTS.md",
    "$REPO/AGENTS.md",
  ]);
  assert.equal(
    nestedSnapshot.effective.resources.some(
      (resource) => resource.displayPath === "$REPO/CLAUDE.md",
    ),
    false,
  );
  assert.equal(
    nestedSnapshot.effective.resources.find(
      (resource) => resource.displayPath === "$REPO/packages/web/AGENTS.md",
    )?.state,
    "inactive",
  );
});

test("applies OpenCode skill and config-source precedence without activating instructions fields", async () => {
  const context = createContext(path.join(repositoryPath, "packages", "api"));
  const report = createScanReport(
    await scanProvider(new OpenCodeAdapter(), context),
    context,
  );
  const sharedSkills = report.resources.filter(
    (resource) => resource.kind === "skill" && resource.name === "shared-skill",
  );
  const configuredInstructions = report.resources.filter(
    (resource) => resource.origin === "opencode-config-instructions",
  );
  const activeMcp = report.resources.find(
    (resource) =>
      resource.kind === "mcp" &&
      resource.name === "shared-mcp" &&
      resource.state === "active",
  );

  assert.equal(sharedSkills.filter((resource) => resource.state === "active").length, 1);
  assert.equal(
    sharedSkills.find((resource) => resource.state === "active")?.displayPath,
    "$REPO/packages/api/.opencode/skills/shared-skill/SKILL.md",
  );
  assert.equal(
    report.resources.find(
      (resource) => resource.kind === "skill" && resource.name === "web-skill",
    )?.state,
    "inactive",
  );
  assert.ok(configuredInstructions.length >= 5);
  assert.ok(
    configuredInstructions.every(
      (resource) =>
        resource.state === "inactive" && resource.metadata.configuredOnly === true,
    ),
  );
  assert.equal(
    activeMcp?.displayPath,
    "$REPO/packages/api/.opencode/opencode.jsonc",
  );
  assert.equal(
    report.resources.filter(
      (resource) => resource.kind === "mcp" && resource.name === "shared-mcp" && resource.state === "active",
    ).length,
    1,
  );

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(fixtureRoot), false);
  assert.equal(serialized.includes("fixture-sensitive"), false);
  assert.equal(serialized.includes("fixture-password"), false);
});
