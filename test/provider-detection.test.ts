import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ProviderAdapter,
  ScanContext,
} from "../src/core/provider-adapter.ts";
import type { ProviderId } from "../src/core/schema.ts";
import { scanProvider } from "../src/core/scanner.ts";
import { ClaudeAdapter } from "../src/providers/claude.ts";
import { CodexAdapter } from "../src/providers/codex.ts";
import { GrokAdapter } from "../src/providers/grok.ts";
import { HermesAdapter } from "../src/providers/hermes.ts";
import { OpenCodeAdapter } from "../src/providers/opencode.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/provider-detection", import.meta.url),
);
const adapters: ProviderAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GrokAdapter(),
  new OpenCodeAdapter(),
  new HermesAdapter(),
];

function createContext(
  provider: ProviderId,
  versionKind: "unknown" | "future" | "missing",
): ScanContext {
  const homeDirectory = path.join(fixtureRoot, "home");
  const repositoryPath = path.join(fixtureRoot, "repo");
  return {
    homeDirectory,
    repositoryPath,
    workingDirectory: repositoryPath,
    environment: {
      CODEX_HOME: path.join(homeDirectory, ".codex"),
      HERMES_HOME: path.join(homeDirectory, ".hermes"),
    },
    executables: {
      [provider]: path.join(
        fixtureRoot,
        "bin",
        versionKind === "missing" ? "missing-provider" : `${provider}-${versionKind}`,
      ),
    },
    adminRoots: {
      claude: path.join(fixtureRoot, "admin", "claude"),
    },
  };
}

test("reports unrecognized versions without applying guessed discovery rules", async () => {
  for (const adapter of adapters) {
    const context = createContext(adapter.provider, "unknown");
    const snapshot = await scanProvider(adapter, context);

    assert.equal(snapshot.detection.installed, true, adapter.provider);
    assert.equal(snapshot.detection.version, "unknown", adapter.provider);
    assert.equal(snapshot.detection.support, "unsupported", adapter.provider);
    assert.deepEqual(snapshot.effective.resources, [], adapter.provider);
    assert.ok(
      snapshot.findings.some(
        (finding) => finding.code === "provider.version.unsupported",
      ),
      adapter.provider,
    );
  }
});

test("reports future provider generations as unsupported", async () => {
  for (const adapter of adapters) {
    const context = createContext(adapter.provider, "future");
    const snapshot = await scanProvider(adapter, context);

    assert.equal(snapshot.detection.installed, true, adapter.provider);
    assert.equal(snapshot.detection.support, "unsupported", adapter.provider);
    assert.deepEqual(snapshot.effective.resources, [], adapter.provider);
    assert.ok(
      snapshot.findings.some(
        (finding) => finding.code === "provider.version.unsupported",
      ),
      adapter.provider,
    );
  }
});

test("distinguishes missing providers from unsupported installed versions", async () => {
  for (const adapter of adapters) {
    const snapshot = await scanProvider(
      adapter,
      createContext(adapter.provider, "missing"),
    );
    const detection = snapshot.detection;

    assert.equal(detection.installed, false, adapter.provider);
    assert.equal(detection.version, "unknown", adapter.provider);
    assert.equal(detection.support, "unavailable", adapter.provider);
    assert.ok(
      snapshot.findings.some(
        (finding) => finding.code === "provider.executable.unavailable",
      ),
      adapter.provider,
    );
  }
});
