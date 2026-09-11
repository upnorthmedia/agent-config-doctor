import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { scanProviders } from "../src/core/coordinator.ts";
import { ClaudeAdapter } from "../src/providers/claude.ts";
import { CodexAdapter } from "../src/providers/codex.ts";
import { GrokAdapter } from "../src/providers/grok.ts";
import { HermesAdapter } from "../src/providers/hermes.ts";
import { OpenCodeAdapter } from "../src/providers/opencode.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/codex/instruction-chain", import.meta.url),
);
const homeDirectory = path.join(fixtureRoot, "home");
const repositoryPath = path.join(fixtureRoot, "repo");
const missingExecutable = path.join(fixtureRoot, "bin", "missing-provider");
const context: ScanContext = {
  homeDirectory,
  repositoryPath,
  workingDirectory: path.join(repositoryPath, "packages", "api", "src"),
  environment: {
    CODEX_HOME: path.join(homeDirectory, ".codex"),
  },
  executables: {
    claude: missingExecutable,
    codex: path.join(fixtureRoot, "bin", "codex"),
    grok: missingExecutable,
    opencode: missingExecutable,
    hermes: missingExecutable,
  },
};

const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GrokAdapter(),
  new OpenCodeAdapter(),
  new HermesAdapter(),
];

test("coordinates every provider into one deterministic redacted report", async () => {
  const first = await scanProviders(adapters, context);
  const second = await scanProviders(adapters, context);
  const serialized = `${JSON.stringify(first.report, null, 2)}\n`;

  assert.equal(first.report.schemaVersion, 1);
  assert.equal(first.report.subject.repository, "$REPO");
  assert.equal(first.report.subject.workingDirectory, "$REPO/packages/api/src");
  assert.deepEqual(
    first.report.providers.map((provider) => provider.provider),
    ["claude", "codex", "grok", "opencode", "hermes"],
  );
  assert.equal(first.snapshots.length, 5);
  assert.ok(first.report.resources.some((resource) => resource.provider === "codex"));
  assert.equal(first.report.effective.codex.orderedResourceIds.length, 4);
  assert.ok(
    first.report.findings.some(
      (finding) =>
        finding.provider === "codex" &&
        finding.code === "codex.skill.name-directory-mismatch",
    ),
  );
  assert.equal(serialized.includes(fixtureRoot), false);
  assert.equal(serialized.includes("fixture-sensitive"), false);
  assert.equal(serialized, `${JSON.stringify(second.report, null, 2)}\n`);
});
