import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixtureRoot = fileURLToPath(
  new URL("./fixtures/codex/instruction-chain", import.meta.url),
);
const repositoryPath = path.join(fixtureRoot, "repo");
const homeDirectory = path.join(fixtureRoot, "home");
const executableDirectory = path.dirname(process.execPath);

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDirectory,
      CODEX_HOME: path.join(homeDirectory, ".codex"),
      PATH: [path.join(fixtureRoot, "bin"), executableDirectory, "/usr/bin", "/bin"].join(
        path.delimiter,
      ),
    },
  });
}

async function runDashboardCli(...args: string[]) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      HOME: homeDirectory,
      CODEX_HOME: path.join(homeDirectory, ".codex"),
      PATH: [path.join(fixtureRoot, "bin"), executableDirectory, "/usr/bin", "/bin"].join(
        path.delimiter,
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI did not start:\n${stdout}\n${stderr}`)), 5_000);
    child.stdout.on("data", () => {
      const match = stdout.match(/Dashboard: (http:\/\/127\.0\.0\.1:\d+\/#credential=[A-Za-z0-9_%_-]+)/);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`CLI exited before startup with ${code}:\n${stdout}\n${stderr}`));
    });
  });
  const page = await fetch(url);
  assert.equal(page.status, 200);
  child.kill("SIGINT");
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { exitCode, stderr, stdout, url };
}

test("prints help when requested", () => {
  const result = runCli("--help");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Agent Config Doctor\n/);
  assert.match(result.stdout, /agent-config-doctor scan \[path\] --json/);
  assert.match(result.stdout, /agent-config-doctor doctor \[path\]/);
  assert.match(result.stdout, /--no-open/);
  assert.match(result.stdout, /--editor <name>/);
  assert.match(result.stdout, /--help/);
});

test("writes stable aggregate scan JSON alone on stdout", () => {
  const first = runCli("scan", repositoryPath, "--json");
  const second = runCli("scan", repositoryPath, "--json");

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout) as {
    schemaVersion: number;
    subject: { repository: string };
    providers: Array<{ provider: string }>;
    resources: Array<{ provider: string }>;
  };
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.subject.repository, "$REPO");
  assert.equal(report.providers.length, 5);
  assert.ok(report.resources.some((resource) => resource.provider === "codex"));
  assert.equal(first.stdout.includes(fixtureRoot), false);
  assert.equal(first.stdout.includes("fixture-sensitive"), false);
});

test("prints a concise redacted doctor summary", () => {
  const result = runCli("doctor", path.join(repositoryPath, "missing"));

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Error: selected path does not exist\./);
});

test("writes usage errors only to stderr", () => {
  const result = runCli("scan", path.join(repositoryPath, "missing"), "--json");

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Error: selected path does not exist\./);
});

test("starts the default protected dashboard with --no-open and shuts down cleanly", async () => {
  const result = await runDashboardCli(repositoryPath, "--no-open");

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Agent Config Doctor\n/);
  assert.match(result.stdout, /Press Ctrl-C to stop\./);
  assert.match(result.stdout, /Shutting down\./);
  assert.equal(result.stdout.includes(fixtureRoot), false);
});

test("doctor prints findings and serves a local dashboard URL", async () => {
  const result = await runDashboardCli("doctor", repositoryPath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Agent Config Doctor\n/);
  assert.match(result.stdout, /Providers: 1 detected, 4 unavailable/);
  assert.match(result.stdout, /Resources: \d+ installed, [1-9]\d* elsewhere in repository/);
  assert.match(result.stdout, /Findings: 1 error, 4 warnings, 0 info/);
  assert.equal(result.stdout.includes(fixtureRoot), false);
  assert.equal(result.stdout.includes("fixture-sensitive"), false);
});

test("rejects editor overrides outside the GUI allowlist", () => {
  const result = runCli(repositoryPath, "--no-open", "--editor", "vim");

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Error: Unsupported editor "vim"\./);
});
