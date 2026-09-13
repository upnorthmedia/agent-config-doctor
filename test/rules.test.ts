import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { describeFinding } from "../src/core/rules.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import type { Finding, ResourceRecord } from "../src/core/schema.ts";
import { CodexAdapter } from "../src/providers/codex.ts";

const codexFixture = fileURLToPath(
  new URL("./fixtures/codex/instruction-chain", import.meta.url),
);

function skill(
  overrides: Partial<Omit<ResourceRecord, "generated">> & { generated?: boolean },
): ResourceRecord {
  const { generated, ...rest } = { generated: true, ...overrides };
  return {
    id: "skill-id",
    kind: "skill",
    provider: "codex",
    providerVersion: "0.154.0",
    name: "Presentations",
    scope: "user",
    origin: "codex-system",
    owner: { type: "provider", id: "codex" },
    path: "/home/user/.codex/skills/.system/presentations/SKILL.md",
    displayPath: "$CODEX_HOME/skills/.system/presentations/SKILL.md",
    reach: "chain",
    loadMode: "on-demand",
    ...(generated ? { generated } : {}),
    state: "active",
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: "parsed:file:$CODEX_HOME/skills/.system/presentations/SKILL.md",
    capabilities: [],
    metadata: {},
    findings: [],
    ...rest,
  };
}

test("a provider-managed name mismatch is described as a reference-only note", () => {
  const finding: Finding = {
    code: "codex.skill.name-directory-mismatch",
    severity: "info",
    confidence: "high",
    message:
      "Skill name Presentations does not match directory presentations. Codex manages this skill, so no action is needed.",
    resourceId: "skill-id",
  };

  const described = describeFinding(finding, skill({}));

  assert.equal(described.title, "Skill folder and metadata use different capitalization");
  assert.equal(described.impact, "No impact detected. Codex manages this bundled skill.");
  assert.equal(described.owner, "provider");
  assert.equal(described.remediation, "None. Shown for reference only.");
  assert.equal(described.evidence, "Presentations in presentations/SKILL.md");
  assert.equal(described.actionable, false);
  assert.equal(described.code, finding.code);
  assert.equal(described.message, finding.message);
});

test("a user-controlled name mismatch is actionable with a concrete fix", () => {
  const finding: Finding = {
    code: "codex.skill.name-directory-mismatch",
    severity: "warning",
    confidence: "medium",
    message: "Skill name Audit does not match directory user-audit.",
    resourceId: "skill-id",
  };

  const described = describeFinding(
    finding,
    skill({
      name: "Audit",
      owner: { type: "self" },
      generated: false,
      displayPath: "$HOME/.agents/skills/user-audit/SKILL.md",
      origin: "agents-home",
    }),
  );

  assert.equal(described.title, "Skill folder and metadata use different names");
  assert.equal(described.owner, "self");
  assert.equal(described.actionable, true);
  assert.equal(described.evidence, "Audit in user-audit/SKILL.md");
  assert.match(described.remediation ?? "", /Rename the folder or change the name field/);
  assert.match(described.impact ?? "", /still loads/);
});

test("plugin, administrator, and provider-level findings are never actionable by the user", () => {
  const pluginFinding = describeFinding(
    {
      code: "claude.skill.invalid-frontmatter",
      severity: "error",
      confidence: "high",
      message: "SKILL.md frontmatter is not valid YAML.",
      resourceId: "skill-id",
    },
    skill({ provider: "claude", owner: { type: "plugin", id: "docs@market" } }),
  );
  assert.equal(pluginFinding.title, "Skill metadata cannot be parsed");
  assert.equal(pluginFinding.owner, "plugin");
  assert.equal(pluginFinding.actionable, false);
  assert.match(pluginFinding.remediation ?? "", /plugin docs@market/);
  assert.equal(pluginFinding.evidence, "SKILL.md frontmatter is not valid YAML.");

  const adminFinding = describeFinding(
    {
      code: "claude.instruction.broken-import",
      severity: "error",
      confidence: "high",
      message: "Imported instruction $HOME/missing.md is missing or unreadable.",
      resourceId: "skill-id",
    },
    skill({ kind: "instruction", owner: { type: "administrator" }, generated: false }),
  );
  assert.equal(adminFinding.owner, "administrator");
  assert.equal(adminFinding.actionable, false);
  assert.match(adminFinding.remediation ?? "", /administrator/);

  const providerFinding = describeFinding(
    {
      code: "provider.version.unsupported",
      severity: "warning",
      confidence: "high",
      message: "The installed opencode version (2.0.0) is not supported by this adapter.",
    },
    undefined,
  );
  assert.equal(providerFinding.title, "Installed provider version is not supported");
  assert.equal(providerFinding.owner, "provider");
  assert.equal(providerFinding.actionable, false);
});

test("an unknown rule code falls back to the raw message without claiming actionability", () => {
  const described = describeFinding(
    {
      code: "future.rule",
      severity: "warning",
      confidence: "low",
      message: "Something new happened.",
    },
    undefined,
  );

  assert.equal(described.title, "Something new happened.");
  assert.equal(described.actionable, false);
  assert.equal(described.evidence, "Something new happened.");
});

test("scan reports carry the rule catalog description on every finding", async () => {
  const context: ScanContext = {
    homeDirectory: path.join(codexFixture, "home"),
    repositoryPath: path.join(codexFixture, "repo"),
    workingDirectory: path.join(codexFixture, "repo", "packages", "api", "src"),
    environment: { CODEX_HOME: path.join(codexFixture, "home", ".codex") },
    executables: { codex: path.join(codexFixture, "bin", "codex") },
  };
  const snapshot = await scanProvider(new CodexAdapter(), context);
  const report = createScanReport(snapshot, context);

  assert.ok(report.findings.length > 0);
  for (const finding of report.findings) {
    assert.equal(typeof finding.title, "string");
    assert.equal(typeof finding.impact, "string");
    assert.equal(typeof finding.remediation, "string");
    assert.equal(typeof finding.evidence, "string");
    assert.equal(typeof finding.actionable, "boolean");
    assert.ok(finding.owner);
  }
  const userSkill = report.resources.find((resource) =>
    resource.displayPath?.endsWith("mismatched-directory/SKILL.md"),
  );
  const userFinding = report.findings.find((finding) => finding.resourceId === userSkill?.id);
  assert.equal(userFinding?.actionable, true);
  assert.equal(userFinding?.owner, "self");
  assert.equal(userSkill?.findings[0]?.actionable, true);
  const pluginSkill = report.resources.find((resource) =>
    resource.displayPath?.endsWith("plugin-mismatch/SKILL.md"),
  );
  const pluginFinding = report.findings.find((finding) => finding.resourceId === pluginSkill?.id);
  assert.equal(pluginFinding?.actionable, false);
  assert.equal(pluginFinding?.owner, "plugin");
});
