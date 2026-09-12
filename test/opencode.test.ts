import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ProviderDetection, ScanContext } from "../src/core/provider-adapter.ts";
import type { ScanSnapshot } from "../src/core/schema.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { OpenCodeAdapter } from "../src/providers/opencode.ts";

// The 2.x rules are documented but not verified against a released binary,
// so detection never reports them as supported. These tests exercise the
// isolated v2 module through a constructed detection to keep its rules
// covered until a release can be tested.
async function scanAsVerifiedV2(context: ScanContext): Promise<ScanSnapshot> {
  const adapter = new OpenCodeAdapter();
  const detection: ProviderDetection = {
    ...(await adapter.detect(context)),
    support: "supported",
  };
  const discovery = await adapter.discover(context, detection);
  const effective = await adapter.resolveEffective(context, discovery.resources, detection);
  return {
    detection,
    effective,
    findings: await adapter.validate(context, effective.resources),
    notices: discovery.notices,
  };
}

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

test("reports OpenCode 2.x as installed but not release-verified", async () => {
  const snapshot = await scanProvider(new OpenCodeAdapter(), createContext());

  assert.equal(snapshot.detection.installed, true);
  assert.equal(snapshot.detection.version, "2.3.1");
  assert.equal(snapshot.detection.generation, "v2");
  assert.equal(snapshot.detection.support, "unsupported");
  assert.deepEqual(snapshot.detection.configRoots, [
    path.join(fixtureRoot, "home", ".config", "opencode"),
    path.join(repositoryPath, ".opencode"),
  ]);
  assert.deepEqual(snapshot.effective.resources, []);
  const finding = snapshot.findings.find((item) => item.code === "provider.version.unsupported");
  assert.match(finding?.message ?? "", /not verified against a released binary/);
});

test("reports OpenCode 1.18 as supported through the 1.18 rules", async () => {
  const adapter = new OpenCodeAdapter();
  const context = createContext(repositoryPath, "opencode-legacy");
  const snapshot = await scanProvider(adapter, context);

  assert.equal(snapshot.detection.installed, true);
  assert.equal(snapshot.detection.version, "1.18.30");
  assert.equal(snapshot.detection.generation, "v1");
  assert.equal(snapshot.detection.support, "supported");
  assert.ok(snapshot.effective.resources.length > 0);
});

test("resolves documented OpenCode V2 AGENTS files for root and nested workspaces", async () => {
  const rootSnapshot = await scanAsVerifiedV2(createContext());
  const nestedContext = createContext(path.join(repositoryPath, "packages", "api"));
  const nestedSnapshot = await scanAsVerifiedV2(nestedContext);
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

test("applies documented OpenCode V2 skill and config-source precedence without activating instructions fields", async () => {
  const context = createContext(path.join(repositoryPath, "packages", "api"));
  const report = createScanReport(await scanAsVerifiedV2(context), context);
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
