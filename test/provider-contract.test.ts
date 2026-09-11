import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ProviderAdapter,
  ScanContext,
} from "../src/core/provider-adapter.ts";
import {
  createScanReport,
  scanProvider,
  serializeScanReport,
} from "../src/core/scanner.ts";
import { ClaudeAdapter } from "../src/providers/claude.ts";
import { CodexAdapter } from "../src/providers/codex.ts";
import { GrokAdapter } from "../src/providers/grok.ts";
import { HermesAdapter } from "../src/providers/hermes.ts";
import { OpenCodeAdapter } from "../src/providers/opencode.ts";

const testRoot = fileURLToPath(new URL(".", import.meta.url));

function providerCases(): Array<{
  adapter: ProviderAdapter;
  context: ScanContext;
}> {
  const claude = path.join(testRoot, "fixtures", "claude", "provider");
  const codex = path.join(testRoot, "fixtures", "codex", "instruction-chain");
  const grok = path.join(testRoot, "fixtures", "grok", "provider");
  const opencode = path.join(testRoot, "fixtures", "opencode", "provider");
  const hermes = path.join(testRoot, "fixtures", "hermes", "provider");
  const claudeRepo = path.join(claude, "repo");
  const codexRepo = path.join(codex, "repo");
  const grokRepo = path.join(grok, "repo");
  const opencodeRepo = path.join(opencode, "repo");
  const hermesRepo = path.join(hermes, "repo");

  return [
    {
      adapter: new ClaudeAdapter(),
      context: {
        homeDirectory: path.join(claude, "home"),
        repositoryPath: claudeRepo,
        workingDirectory: path.join(claudeRepo, "packages", "api"),
        environment: {},
        executables: { claude: path.join(claude, "bin", "claude") },
        adminRoots: { claude: path.join(claude, "admin", "claude") },
      },
    },
    {
      adapter: new CodexAdapter(),
      context: {
        homeDirectory: path.join(codex, "home"),
        repositoryPath: codexRepo,
        workingDirectory: path.join(codexRepo, "packages", "api", "src"),
        environment: { CODEX_HOME: path.join(codex, "home", ".codex") },
        executables: { codex: path.join(codex, "bin", "codex") },
      },
    },
    {
      adapter: new GrokAdapter(),
      context: {
        homeDirectory: path.join(grok, "home"),
        repositoryPath: grokRepo,
        workingDirectory: path.join(grokRepo, "packages", "api"),
        environment: {},
        executables: { grok: path.join(grok, "bin", "grok") },
      },
    },
    {
      adapter: new OpenCodeAdapter(),
      context: {
        homeDirectory: path.join(opencode, "home"),
        repositoryPath: opencodeRepo,
        workingDirectory: path.join(opencodeRepo, "packages", "api"),
        environment: {},
        executables: { opencode: path.join(opencode, "bin", "opencode") },
      },
    },
    {
      adapter: new HermesAdapter(),
      context: {
        homeDirectory: path.join(hermes, "home"),
        repositoryPath: hermesRepo,
        workingDirectory: path.join(hermesRepo, "packages", "api", "src"),
        environment: {
          HERMES_HOME: path.join(hermes, "home", ".hermes"),
          HERMES_FIXTURE_EXTERNAL: path.join(hermes, "external", "skills"),
        },
        executables: { hermes: path.join(hermes, "bin", "hermes") },
      },
    },
  ];
}

test("all provider fixtures satisfy the normalized deterministic scan contract", async () => {
  for (const { adapter, context } of providerCases()) {
    const first = createScanReport(await scanProvider(adapter, context), context);
    const second = createScanReport(await scanProvider(adapter, context), context);
    const serialized = serializeScanReport(first);
    const resourceIds = new Set(first.resources.map((resource) => resource.id));

    assert.equal(first.detection.support, "supported", adapter.provider);
    assert.equal(first.resources.length > 0, true, adapter.provider);
    assert.equal(resourceIds.size, first.resources.length, adapter.provider);
    assert.ok(
      first.resources.every(
        (resource) =>
          resource.provider === adapter.provider &&
          resource.providerVersion === first.detection.version &&
          resource.evidenceReceipt.length > 0,
      ),
      adapter.provider,
    );
    assert.ok(
      first.effective.orderedResourceIds.every(
        (id) =>
          first.resources.find((resource) => resource.id === id)?.state === "active",
      ),
      adapter.provider,
    );
    assert.equal(serialized.includes(testRoot), false, adapter.provider);
    assert.equal(serialized.includes("fixture-sensitive"), false, adapter.provider);
    assert.equal(serialized.includes("fixture-password"), false, adapter.provider);
    assert.equal(serialized, serializeScanReport(second), adapter.provider);
  }
});

test("normalized records keep managed, protected, disabled, shadowed, and blocked meanings distinct", async () => {
  const reports = await Promise.all(
    providerCases().map(async ({ adapter, context }) =>
      createScanReport(await scanProvider(adapter, context), context),
    ),
  );
  const resources = reports.flatMap((report) => report.resources);
  const protectedResource = resources.find(
    (resource) => resource.origin === "hermes-bundled-protected",
  );

  assert.ok(resources.some((resource) => resource.scope === "managed"));
  assert.equal(protectedResource?.state, "active");
  assert.equal(protectedResource?.metadata.syncProtection, "user-modified");
  assert.ok(resources.some((resource) => resource.state === "disabled"));
  assert.ok(resources.some((resource) => resource.state === "shadowed"));
  assert.ok(resources.some((resource) => resource.state === "blocked"));
});
