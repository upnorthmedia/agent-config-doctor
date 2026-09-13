import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { scanProviders } from "../src/core/coordinator.ts";
import type { ScanContext } from "../src/core/provider-adapter.ts";
import { CodexAdapter } from "../src/providers/codex.ts";
import type {
  SpawnedProcess,
  SpawnProcess,
} from "../src/server/actions.ts";
import { startDashboardServer } from "../src/server/server.ts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/codex/instruction-chain", import.meta.url),
);

async function createScanFixture(
  t: TestContext,
  options: { symlinked?: boolean; content?: string | Buffer } = {},
) {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "agent-config-server-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "agent-config-server-outside-"));
  const instructionPath = path.join(repositoryPath, "AGENTS.md");
  const originalTarget = path.join(repositoryPath, "original.md");
  const content = options.content ?? "# Original\n";
  if (options.symlinked) {
    await writeFile(originalTarget, content);
    await symlink(originalTarget, instructionPath);
  } else {
    await writeFile(instructionPath, content);
  }
  t.after(async () => {
    await rm(repositoryPath, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  const homeDirectory = path.join(fixtureRoot, "home");
  const context: ScanContext = {
    homeDirectory,
    repositoryPath,
    workingDirectory: repositoryPath,
    environment: { CODEX_HOME: path.join(homeDirectory, ".codex") },
    executables: { codex: path.join(fixtureRoot, "bin", "codex") },
  };
  const scan = await scanProviders([new CodexAdapter()], context);
  const resourceId = scan.report.resources.find(
    (resource) => resource.displayPath === "$REPO/AGENTS.md",
  )?.id;
  assert.ok(resourceId);
  return { instructionPath, outsideRoot, resourceId, scan };
}

function headers(server: Awaited<ReturnType<typeof startDashboardServer>>) {
  return {
    Authorization: `Bearer ${server.credential}`,
    "Content-Type": "application/json",
    Origin: server.origin,
  };
}

function successfulProcess(): SpawnedProcess {
  const child = new EventEmitter() as EventEmitter & SpawnedProcess;
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("protects local data with a per-process credential and restrictive headers", async (t) => {
  const { scan } = await createScanFixture(t);
  const first = await startDashboardServer({ initialScan: scan, port: 0 });
  const second = await startDashboardServer({ initialScan: scan, port: 0 });
  t.after(() => first.close());
  t.after(() => second.close());

  assert.equal(first.host, "127.0.0.1");
  assert.notEqual(first.port, 0);
  assert.notEqual(first.credential, second.credential);
  assert.match(first.credential, /^[A-Za-z0-9_-]{40,}$/);

  const page = await fetch(first.origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.has("access-control-allow-origin"), false);
  const pageBody = await page.text();
  assert.equal(pageBody.includes(first.credential), false);
  assert.match(pageBody, /What configuration exists\?/);

  const stylesheet = await fetch(`${first.origin}/assets/dashboard.css`);
  const clientScript = await fetch(`${first.origin}/assets/dashboard.js`);
  assert.equal(stylesheet.status, 200);
  assert.equal(clientScript.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /^text\/css/);
  assert.match(clientScript.headers.get("content-type") ?? "", /^text\/javascript/);
  const favicon = await fetch(`${first.origin}/favicon.ico`);
  assert.equal(favicon.status, 204);

  const rejected = await fetch(`${first.origin}/api/scan`);
  assert.equal(rejected.status, 401);
  const accepted = await fetch(`${first.origin}/api/scan`, {
    headers: { Authorization: `Bearer ${first.credential}` },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.has("access-control-allow-origin"), false);
  const body = await accepted.text();
  assert.equal(body.includes(fixtureRoot), false);
  assert.equal(body.includes("fixture-sensitive"), false);

  const optionResponse = await fetch(`${first.origin}/api/options`, {
    headers: { Authorization: `Bearer ${first.credential}` },
  });
  assert.equal(optionResponse.status, 200);
  const optionBody = await optionResponse.text();
  assert.equal(optionBody.includes(fixtureRoot), false);
  assert.equal(optionBody.includes("executablePath"), false);
  const publicOptions = JSON.parse(optionBody) as { scannedAt: string; version: string };
  assert.equal(Number.isNaN(Date.parse(publicOptions.scannedAt)), false);
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(publicOptions.version, metadata.version);
});

test("scans only the launch directory and never infers switchable working directories", async (t) => {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "agent-config-cwd-root-"),
  );
  const nestedPath = path.join(repositoryPath, "packages", "api");
  await mkdir(nestedPath, { recursive: true });
  await mkdir(path.join(repositoryPath, "packages", "web"), { recursive: true });
  await writeFile(path.join(repositoryPath, "AGENTS.md"), "# Root\n", "utf8");
  await writeFile(path.join(nestedPath, "AGENTS.md"), "# Nested\n", "utf8");
  await writeFile(path.join(repositoryPath, "packages", "web", "AGENTS.md"), "# Web\n", "utf8");
  t.after(() => rm(repositoryPath, { recursive: true, force: true }));

  const homeDirectory = path.join(fixtureRoot, "home");
  const context: ScanContext = {
    homeDirectory,
    repositoryPath,
    workingDirectory: nestedPath,
    environment: { CODEX_HOME: path.join(homeDirectory, ".codex") },
    executables: { codex: path.join(fixtureRoot, "bin", "codex") },
  };
  const initialScan = await scanProviders([new CodexAdapter()], context);
  const server = await startDashboardServer({ initialScan, port: 0 });
  t.after(() => server.close());
  const authorization = { Authorization: `Bearer ${server.credential}` };

  const options = await (
    await fetch(`${server.origin}/api/options`, { headers: authorization })
  ).json() as Record<string, unknown>;
  assert.equal(options.workingDirectory, "$REPO/packages/api");
  assert.equal("workingDirectories" in options, false);
  assert.equal("selectedWorkingDirectoryId" in options, false);

  const report = await (
    await fetch(`${server.origin}/api/scan`, { headers: authorization })
  ).json() as {
    subject: { workingDirectory: string };
    resources: Array<{ displayPath?: string; reach?: string }>;
  };
  assert.equal(report.subject.workingDirectory, "$REPO/packages/api");
  assert.equal(
    report.resources.find((resource) => resource.displayPath === "$REPO/packages/web/AGENTS.md")?.reach,
    "repository",
  );

  const query = await fetch(`${server.origin}/api/scan?cwd=packages`, {
    headers: authorization,
  });
  assert.equal(query.status, 400);
  const selection = await fetch(
    `${server.origin}/api/actions/select-working-directory`,
    {
      method: "POST",
      headers: headers(server),
      body: JSON.stringify({ workingDirectoryId: "any" }),
    },
  );
  assert.equal(selection.status, 404);
});

test("rejects invalid origins, arbitrary paths, and forged resource IDs over HTTP", async (t) => {
  const { resourceId, scan } = await createScanFixture(t);
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawnProcess: SpawnProcess = (command, args) => {
    calls.push({ command, args });
    return successfulProcess();
  };
  const server = await startDashboardServer({
    initialScan: scan,
    port: 0,
    editor: {
      id: "code",
      label: "Visual Studio Code",
      executablePath: "/usr/local/bin/code",
    },
    spawnProcess,
  });
  t.after(() => server.close());

  const invalidOrigin = await fetch(`${server.origin}/api/actions/open`, {
    method: "POST",
    headers: { ...headers(server), Origin: "http://evil.example" },
    body: JSON.stringify({ resourceId }),
  });
  assert.equal(invalidOrigin.status, 403);

  const arbitraryPath = await fetch(`${server.origin}/api/actions/open`, {
    method: "POST",
    headers: headers(server),
    body: JSON.stringify({ resourceId, path: "/etc/passwd" }),
  });
  assert.equal(arbitraryPath.status, 400);

  const forgedId = await fetch(`${server.origin}/api/actions/open`, {
    method: "POST",
    headers: headers(server),
    body: JSON.stringify({ resourceId: "forged-resource-id" }),
  });
  assert.equal(forgedId.status, 404);

  const valid = await fetch(`${server.origin}/api/actions/open`, {
    method: "POST",
    headers: headers(server),
    body: JSON.stringify({ resourceId }),
  });
  assert.equal(valid.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args.slice(0, 1), ["--goto"]);
});

test("rejects a file replaced after the HTTP server inventory was created", async (t) => {
  const { instructionPath, resourceId, scan } = await createScanFixture(t);
  const server = await startDashboardServer({ initialScan: scan, port: 0 });
  t.after(() => server.close());
  await unlink(instructionPath);
  await writeFile(instructionPath, "# Replaced\n", "utf8");

  const response = await fetch(`${server.origin}/api/resources/${resourceId}/path`, {
    headers: { Authorization: `Bearer ${server.credential}` },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "resource_replaced",
    message: "The discovered resource changed after the scan. Scan again before opening it.",
  });
});

test("rejects a symlink redirected outside the root after server startup", async (t) => {
  const { instructionPath, outsideRoot, resourceId, scan } = await createScanFixture(t, {
    symlinked: true,
  });
  const server = await startDashboardServer({ initialScan: scan, port: 0 });
  t.after(() => server.close());
  const outsidePath = path.join(outsideRoot, "outside.md");
  await writeFile(outsidePath, "# Outside\n", "utf8");
  await unlink(instructionPath);
  await symlink(outsidePath, instructionPath);

  const response = await fetch(`${server.origin}/api/resources/${resourceId}/path`, {
    headers: { Authorization: `Bearer ${server.credential}` },
  });

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, "resource_replaced");
});

test("refuses to create a dashboard action service on a non-loopback host", async () => {
  const context: ScanContext = {
    homeDirectory: path.join(fixtureRoot, "home"),
    repositoryPath: path.join(fixtureRoot, "repo"),
    workingDirectory: path.join(fixtureRoot, "repo"),
    environment: {},
    executables: { codex: path.join(fixtureRoot, "bin", "codex") },
  };
  const scan = await scanProviders([new CodexAdapter()], context);

  await assert.rejects(
    startDashboardServer({ initialScan: scan, host: "0.0.0.0", port: 0 }),
    /Dashboard server must bind exclusively to 127\.0\.0\.1/,
  );
});

test("serves the allowlisted page routes and nothing else as HTML", async (t) => {
  const { resourceId, scan } = await createScanFixture(t);
  const server = await startDashboardServer({ initialScan: scan, port: 0 });
  t.after(() => server.close());
  const home = await (await fetch(server.origin)).text();

  for (const route of ["/installed", "/effective", "/findings", `/resources/${resourceId}`, "/resources/not-yet-known"]) {
    const page = await fetch(`${server.origin}${route}`);
    assert.equal(page.status, 200, route);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(await page.text(), home);
  }
  for (const route of [
    "/installed/",
    "/resources",
    "/resources/",
    "/resources/a%2Fb",
    "/resources/bad.id",
    "/settings",
  ]) {
    const missing = await fetch(`${server.origin}${route}`);
    assert.equal(missing.status, 404, route);
    assert.match(missing.headers.get("content-type") ?? "", /^application\/json/);
  }
  const filtered = await fetch(`${server.origin}/installed?q=agents&provider=codex`);
  assert.equal(filtered.status, 200);
});

test("previews a file-backed instruction as unmodified UTF-8 text with no-store caching", async (t) => {
  const content = "# Original\n\nLine two has ünïcödé and <tags> & \"quotes\".\n";
  const { resourceId, scan } = await createScanFixture(t, { content });
  const server = await startDashboardServer({ initialScan: scan, port: 0 });
  t.after(() => server.close());

  const unauthenticated = await fetch(`${server.origin}/api/resources/${resourceId}/preview`);
  assert.equal(unauthenticated.status, 401);

  const options = await (
    await fetch(`${server.origin}/api/options`, { headers: { Authorization: `Bearer ${server.credential}` } })
  ).json() as { previewableResourceIds: string[]; actionableResourceIds: string[] };
  assert.ok(options.previewableResourceIds.includes(resourceId));
  const configResource = scan.report.resources.find((resource) => resource.kind === "mcp");
  assert.ok(configResource);
  assert.equal(options.previewableResourceIds.includes(configResource.id), false);

  const response = await fetch(`${server.origin}/api/resources/${resourceId}/preview`, {
    headers: { Authorization: `Bearer ${server.credential}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    encoding: "utf-8",
    content,
    empty: false,
    truncated: false,
    size: Buffer.byteLength(content),
    readBytes: Buffer.byteLength(content),
    lineCount: 3,
  });
});

test("refuses previews of forged IDs, configuration files, and files that changed after the scan", async (t) => {
  const { instructionPath, resourceId, scan } = await createScanFixture(t);
  const server = await startDashboardServer({ initialScan: scan, port: 0 });
  t.after(() => server.close());
  const authorization = { Authorization: `Bearer ${server.credential}` };

  const forged = await fetch(`${server.origin}/api/resources/forged-resource-id/preview`, { headers: authorization });
  assert.equal(forged.status, 404);
  assert.equal((await forged.json() as { error: string }).error, "resource_not_found");

  const configResource = scan.report.resources.find((resource) => resource.kind === "mcp");
  assert.ok(configResource);
  const config = await fetch(`${server.origin}/api/resources/${configResource.id}/preview`, { headers: authorization });
  assert.equal(config.status, 404);
  assert.equal((await config.json() as { error: string }).error, "preview_unavailable");

  await unlink(instructionPath);
  await writeFile(instructionPath, "# Replaced\n", "utf8");
  const replaced = await fetch(`${server.origin}/api/resources/${resourceId}/preview`, { headers: authorization });
  assert.equal(replaced.status, 409);
  assert.equal((await replaced.json() as { error: string }).error, "resource_replaced");

  await unlink(instructionPath);
  const missing = await fetch(`${server.origin}/api/resources/${resourceId}/preview`, { headers: authorization });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json() as { error: string }).error, "resource_missing");
});

test("refuses a preview through a symlink swapped to point outside the approved roots", async (t) => {
  const { instructionPath, outsideRoot, resourceId, scan } = await createScanFixture(t, { symlinked: true });
  const server = await startDashboardServer({ initialScan: scan, port: 0 });
  t.after(() => server.close());
  const outsidePath = path.join(outsideRoot, "outside.md");
  await writeFile(outsidePath, "# Outside\n", "utf8");
  await unlink(instructionPath);
  await symlink(outsidePath, instructionPath);

  const response = await fetch(`${server.origin}/api/resources/${resourceId}/preview`, {
    headers: { Authorization: `Bearer ${server.credential}` },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, "resource_replaced");
});

test("refuses binary and non-UTF-8 previews and reports empty, truncated, and oversized files", async (t) => {
  const cases: Array<{ name: string; content: Buffer; expect: (response: Response) => Promise<void> }> = [
    {
      name: "binary",
      content: Buffer.concat([Buffer.from("# Title\n"), Buffer.from([0, 1, 2, 3]), Buffer.from("tail\n")]),
      expect: async (response) => {
        assert.equal(response.status, 415);
        assert.equal((await response.json() as { error: string }).error, "preview_not_text");
      },
    },
    {
      name: "latin-1",
      content: Buffer.concat([Buffer.from("# Caf"), Buffer.from([0xe9]), Buffer.from("\n")]),
      expect: async (response) => {
        assert.equal(response.status, 415);
        assert.equal((await response.json() as { error: string }).error, "preview_not_text");
      },
    },
    {
      name: "empty",
      content: Buffer.alloc(0),
      expect: async (response) => {
        assert.equal(response.status, 200);
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.empty, true);
        assert.equal(body.content, "");
        assert.equal(body.lineCount, 0);
      },
    },
    {
      name: "truncated",
      content: Buffer.from(("é".repeat(60) + "\n").repeat(3000), "utf8"),
      expect: async (response) => {
        assert.equal(response.status, 200);
        const body = await response.json() as { content: string; truncated: boolean; readBytes: number; size: number };
        assert.equal(body.truncated, true);
        assert.ok(body.readBytes <= 256 * 1024);
        assert.ok(body.readBytes > 256 * 1024 - 4);
        assert.equal(Buffer.byteLength(body.content), body.readBytes);
        assert.equal(body.size, 3000 * 121);
        assert.equal(body.content.includes("\uFFFD"), false);
      },
    },
    {
      name: "oversized",
      content: Buffer.alloc(1024 * 1024 + 1, "a"),
      expect: async (response) => {
        assert.equal(response.status, 413);
        assert.equal((await response.json() as { error: string }).error, "preview_too_large");
      },
    },
  ];

  for (const testCase of cases) {
    const { resourceId, scan } = await createScanFixture(t, { content: testCase.content });
    const server = await startDashboardServer({ initialScan: scan, port: 0 });
    t.after(() => server.close());
    const response = await fetch(`${server.origin}/api/resources/${resourceId}/preview`, {
      headers: { Authorization: `Bearer ${server.credential}` },
    });
    await testCase.expect(response);
  }
});
