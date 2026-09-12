import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ScanContext } from "../src/core/provider-adapter.ts";
import { createScanReport, scanProvider } from "../src/core/scanner.ts";
import { CodexAdapter } from "../src/providers/codex.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/codex/instruction-chain", import.meta.url),
);
const homeDirectory = path.join(fixtureRoot, "home");
const repositoryPath = path.join(fixtureRoot, "repo");

function createContext(
  executable: string,
  environment: Record<string, string> = {},
): ScanContext {
  return {
    homeDirectory,
    repositoryPath,
    workingDirectory: path.join(repositoryPath, "packages", "api", "src"),
    environment: {
      CODEX_HOME: path.join(homeDirectory, ".codex"),
      ...environment,
    },
    executables: {
      codex: path.join(fixtureRoot, "bin", executable),
    },
  };
}

test(
  "a cold Codex plugin listing slower than five seconds still yields plugins",
  { timeout: 30_000 },
  async () => {
    const context = createContext("codex-slow", { CODEX_FIXTURE_DELAY_MS: "5500" });
    const snapshot = await scanProvider(new CodexAdapter(), context);
    const plugins = snapshot.effective.resources.filter(
      (resource) => resource.kind === "plugin",
    );

    assert.deepEqual(
      plugins.map((resource) => resource.name).sort(),
      ["disabled-plugin", "fixture-plugin"],
    );
    assert.deepEqual(snapshot.notices, []);
  },
);

test("a timed-out native command produces a provider-scoped notice without inflating findings", async () => {
  const baseline = await scanProvider(new CodexAdapter(), createContext("codex"));
  const context: ScanContext = {
    ...createContext("codex-slow", { CODEX_FIXTURE_DELAY_MS: "1500" }),
    nativeCommandTimeoutMs: 300,
  };
  const snapshot = await scanProvider(new CodexAdapter(), context);
  const report = createScanReport(snapshot, context);
  const timeoutNotice = snapshot.notices.find(
    (notice) => notice.code === "native.command.timeout",
  );

  assert.ok(timeoutNotice, "timeout notice is recorded");
  assert.equal(timeoutNotice.provider, "codex");
  assert.equal(timeoutNotice.command, "codex plugin list --json");
  assert.match(timeoutNotice.message, /timed out/);
  assert.match(timeoutNotice.remediation, /rerun/i);
  assert.equal(
    snapshot.effective.resources.some((resource) => resource.kind === "plugin"),
    false,
  );
  assert.ok(
    snapshot.effective.resources.some((resource) => resource.kind === "mcp"),
    "other native evidence still loads",
  );
  assert.deepEqual(
    snapshot.findings.map((finding) => finding.code).sort(),
    baseline.findings.map((finding) => finding.code).sort(),
  );
  assert.equal(
    snapshot.findings.some((finding) => finding.code.startsWith("native.")),
    false,
  );
  assert.equal(report.detection.complete, false);
  assert.deepEqual(
    report.notices.map((notice) => notice.code),
    ["native.command.timeout"],
  );
  assert.equal(JSON.stringify(report).includes(fixtureRoot), false);
});

test("classifies nonzero exit, malformed JSON, and unavailable commands separately", async () => {
  const failing = await scanProvider(new CodexAdapter(), createContext("codex-failing"));
  assert.deepEqual(
    failing.notices.map((notice) => notice.code),
    ["native.command.nonzero-exit", "native.command.nonzero-exit"],
  );
  assert.deepEqual(
    failing.notices.map((notice) => notice.command).sort(),
    ["codex mcp list --json", "codex plugin list --json"],
  );
  assert.ok(failing.notices.every((notice) => notice.provider === "codex"));
  assert.ok(
    failing.effective.resources.some((resource) => resource.kind === "instruction"),
    "parsed evidence survives a native failure",
  );

  const malformed = await scanProvider(new CodexAdapter(), createContext("codex-malformed"));
  assert.deepEqual(
    malformed.notices.map((notice) => notice.code),
    ["native.command.malformed-json", "native.command.malformed-json"],
  );

  const adapter = new CodexAdapter();
  const context = createContext("codex");
  const detection = await adapter.detect(context);
  const unavailable = await adapter.discover(context, {
    ...detection,
    executablePath: path.join(fixtureRoot, "bin", "missing-codex"),
  });
  assert.deepEqual(
    unavailable.notices.map((notice) => notice.code),
    ["native.command.unavailable", "native.command.unavailable"],
  );
  assert.equal(
    unavailable.resources.some((resource) => resource.kind === "plugin"),
    false,
  );
});

test("a healthy scan reports every provider as complete with no notices", async () => {
  const context = createContext("codex");
  const report = createScanReport(
    await scanProvider(new CodexAdapter(), context),
    context,
  );

  assert.equal(report.detection.complete, true);
  assert.deepEqual(report.notices, []);
});
