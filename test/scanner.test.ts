import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import {
  createScanReport,
  scanProvider,
  serializeScanReport,
} from "../src/core/scanner.ts";
import { CodexAdapter } from "../src/providers/codex.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/codex/instruction-chain", import.meta.url),
);
const homeDirectory = path.join(fixtureRoot, "home");
const repositoryPath = path.join(fixtureRoot, "repo");
const context: ScanContext = {
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

test("creates deterministic schema-versioned redacted scan JSON", async () => {
  const firstSnapshot = await scanProvider(new CodexAdapter(), context);
  const firstReport = createScanReport(firstSnapshot, context);
  const firstJson = serializeScanReport(firstReport);
  const secondSnapshot = await scanProvider(new CodexAdapter(), context);
  const secondJson = serializeScanReport(
    createScanReport(secondSnapshot, context),
  );

  assert.equal(firstReport.schemaVersion, 1);
  assert.equal(firstReport.subject.repository, "$REPO");
  assert.equal(firstReport.subject.workingDirectory, "$REPO/packages/api/src");
  assert.ok(firstReport.resources.some((resource) => resource.kind === "instruction"));
  assert.ok(firstReport.resources.some((resource) => resource.kind === "skill"));
  assert.ok(firstReport.resources.some((resource) => resource.kind === "plugin"));
  assert.ok(firstReport.resources.some((resource) => resource.kind === "mcp"));
  assert.ok(
    firstReport.findings.some(
      (finding) => finding.code === "codex.skill.name-directory-mismatch",
    ),
  );
  assert.equal(firstJson.includes(fixtureRoot), false);
  assert.equal(firstJson.includes("fixture-sensitive"), false);
  assert.equal(firstJson, secondJson);
});

test("redacts known local roots from every public string value", async () => {
  const snapshot = await scanProvider(new CodexAdapter(), context);
  const resource = snapshot.effective.resources[0]!;
  resource.metadata.command = path.join(homeDirectory, ".local", "bin", "server");
  resource.metadata.arguments = [
    "--config",
    path.join(repositoryPath, "config", "agent.json"),
  ];
  resource.precedence.ruleSource = path.join(
    homeDirectory,
    ".codex",
    "config.toml",
  );
  resource.capabilities.push(
    `reads ${path.join(repositoryPath, "AGENTS.md")}`,
  );
  resource.findings.push({
    code: "test.resource-path",
    severity: "warning",
    confidence: "high",
    message: `Resource at ${path.join(homeDirectory, "private", "resource.md")}`,
    resourceId: resource.id,
  });
  snapshot.findings.push({
    code: "test.snapshot-path",
    severity: "warning",
    confidence: "high",
    message: `Repository path ${path.join(repositoryPath, "private", "finding.md")}`,
    resourceId: resource.id,
  });
  snapshot.effective.decisions[0]!.reason =
    `Loaded from ${path.join(homeDirectory, ".codex", "AGENTS.md")}`;

  const serialized = serializeScanReport(createScanReport(snapshot, context));

  assert.equal(serialized.includes(homeDirectory), false);
  assert.equal(serialized.includes(repositoryPath), false);
  assert.match(serialized, /\$HOME\/.local\/bin\/server/);
  assert.match(serialized, /\$REPO\/config\/agent\.json/);
  assert.match(serialized, /\$CODEX_HOME\/config\.toml/);
  assert.match(serialized, /Loaded from \$CODEX_HOME\/AGENTS\.md/);
});

test("matches the Codex installed and effective golden inventory", async () => {
  const snapshot = await scanProvider(new CodexAdapter(), context);
  const report = createScanReport(snapshot, context);
  const pathById = new Map(
    report.resources.map((resource) => [resource.id, resource.displayPath]),
  );
  const summary = {
    schemaVersion: report.schemaVersion,
    providerVersion: report.detection.version,
    orderedInstructions: report.effective.orderedResourceIds.map((id) =>
      pathById.get(id),
    ),
    resources: report.resources.map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      path: resource.displayPath,
      scope: resource.scope,
      origin: resource.origin,
      owner: `${resource.owner.type}${resource.owner.id ? `:${resource.owner.id}` : ""}`,
      state: resource.state,
      evidence: `${resource.evidenceType}:${resource.evidenceReceipt}`,
      ...(typeof resource.precedence.chainOrder === "number"
        ? { order: resource.precedence.chainOrder }
        : {}),
      ...(typeof resource.precedence.shadowedBy === "string"
        ? { shadowedBy: pathById.get(resource.precedence.shadowedBy) }
        : {}),
      ...(typeof resource.precedence.duplicateOf === "string"
        ? { duplicateOf: pathById.get(resource.precedence.duplicateOf) }
        : {}),
    })),
    findingCodes: report.findings.map((finding) => finding.code),
  };
  const expected = await readFile(
    new URL(
      "./fixtures/codex/instruction-chain/expected-scan.json",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(`${JSON.stringify(summary, null, 2)}\n`, expected);
});
