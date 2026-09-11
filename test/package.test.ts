import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJsonPath = path.join(repositoryRoot, "package.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const fixtureRoot = path.join(
  repositoryRoot,
  "test",
  "fixtures",
  "codex",
  "instruction-chain",
);
const fixtureRepository = path.join(fixtureRoot, "repo");
const fixtureHome = path.join(fixtureRoot, "home");

const expectedPackedFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/cli.js",
  "dist/core/coordinator.js",
  "dist/core/provider-adapter.js",
  "dist/core/runtime.js",
  "dist/core/scanner.js",
  "dist/core/schema.js",
  "dist/dashboard/dashboard.js",
  "dist/providers/claude.js",
  "dist/providers/codex.js",
  "dist/providers/grok.js",
  "dist/providers/hermes.js",
  "dist/providers/opencode.js",
  "dist/providers/shared.js",
  "dist/server/actions.js",
  "dist/server/server.js",
  "package.json",
].sort();

interface PackageMetadata {
  name: string;
  version: string;
  private?: boolean;
  description: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  license: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  homepage: string;
  publishConfig: { access: string };
  scripts: { prepack: string };
}

interface PackResult {
  filename: string;
  files: Array<{ mode: number; path: string }>;
}

test("declares the approved public v1 package contract", async () => {
  const metadata = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as PackageMetadata;

  assert.equal(metadata.name, "agent-config-doctor");
  assert.equal(metadata.version, "1.0.0");
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.license, "MIT");
  assert.deepEqual(metadata.engines, { node: ">=24" });
  assert.deepEqual(metadata.bin, {
    "agent-config-doctor": "dist/cli.js",
  });
  assert.deepEqual(metadata.files, [
    "dist/**/*.js",
    "LICENSE",
    "README.md",
    "SECURITY.md",
  ]);
  assert.deepEqual(metadata.repository, {
    type: "git",
    url: "git+https://github.com/upnorthmedia/agent-config-doctor.git",
  });
  assert.deepEqual(metadata.bugs, {
    url: "https://github.com/upnorthmedia/agent-config-doctor/issues",
  });
  assert.equal(
    metadata.homepage,
    "https://github.com/upnorthmedia/agent-config-doctor#readme",
  );
  assert.deepEqual(metadata.publishConfig, { access: "public" });
  assert.equal(metadata.scripts.prepack, "npm run build");
});

test(
  "packs, installs, and runs the exact public artifact",
  { timeout: 120_000 },
  async (t) => {
    const fixtureDigestBefore = await directoryDigest(fixtureRoot);
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-config-package-"),
    );
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

    run(npmCommand, ["run", "build"], repositoryRoot);
    const packOutput = run(
      npmCommand,
      ["pack", "--json", "--pack-destination", temporaryRoot],
      repositoryRoot,
    );
    const [packed] = JSON.parse(packOutput) as PackResult[];
    assert.ok(packed);
    assert.deepEqual(
      packed.files.map((file) => file.path).sort(),
      expectedPackedFiles,
    );
    assert.equal(
      packed.files.find((file) => file.path === "dist/cli.js")?.mode,
      0o755,
    );

    const tarballPath = path.join(temporaryRoot, packed.filename);
    const installRoot = path.join(temporaryRoot, "install");
    await mkdir(installRoot);
    await writeFile(
      path.join(installRoot, "package.json"),
      '{"name":"package-acceptance","private":true}\n',
      "utf8",
    );
    run(
      npmCommand,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--package-lock=false",
        tarballPath,
      ],
      installRoot,
    );

    const installedPackageRoot = path.join(
      installRoot,
      "node_modules",
      "agent-config-doctor",
    );
    const installedMetadata = JSON.parse(
      await readFile(path.join(installedPackageRoot, "package.json"), "utf8"),
    ) as PackageMetadata;
    assert.equal(installedMetadata.version, "1.0.0");
    await access(path.join(installRoot, "node_modules", "smol-toml", "package.json"));
    await access(path.join(installRoot, "node_modules", "yaml", "package.json"));
    await assert.rejects(
      access(path.join(installRoot, "node_modules", "typescript", "package.json")),
    );

    const binaryPath = path.join(
      installRoot,
      "node_modules",
      ".bin",
      process.platform === "win32"
        ? "agent-config-doctor.cmd"
        : "agent-config-doctor",
    );
    if (process.platform !== "win32") {
      await access(binaryPath, constants.X_OK);
      assert.notEqual((await stat(await realpath(binaryPath))).mode & 0o111, 0);
    }

    const environment = acceptanceEnvironment();
    const help = run(binaryPath, ["--help"], installRoot, environment);
    assert.match(help, /^Agent Config Doctor\n/);
    assert.match(help, /agent-config-doctor scan \[path\] --json/);

    const scanOutput = run(
      binaryPath,
      ["scan", fixtureRepository, "--json"],
      installRoot,
      environment,
    );
    const scan = JSON.parse(scanOutput) as {
      schemaVersion: number;
      providers: unknown[];
      subject: { repository: string };
    };
    assert.equal(scan.schemaVersion, 1);
    assert.equal(scan.subject.repository, "$REPO");
    assert.equal(scan.providers.length, 5);
    assert.equal(scanOutput.includes(repositoryRoot), false);
    assert.equal(scanOutput.includes(fixtureRoot), false);

    await smokeDashboard(t, binaryPath, [fixtureRepository, "--no-open"], environment);
    await smokeDashboard(t, binaryPath, ["doctor", fixtureRepository], environment, true);
    await assertPublicPackageContents(installedPackageRoot);
    assert.equal(await directoryDigest(fixtureRoot), fixtureDigestBefore);
  },
);

function run(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function acceptanceEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fixtureHome,
    CODEX_HOME: path.join(fixtureHome, ".codex"),
    PATH: [
      path.join(fixtureRoot, "bin"),
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
  };
}

async function smokeDashboard(
  t: TestContext,
  binaryPath: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  expectDoctorSummary = false,
): Promise<void> {
  const child = spawn(binaryPath, args, {
    cwd: path.dirname(binaryPath),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
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
    const timeout = setTimeout(
      () => reject(new Error(`Packed dashboard did not start. Stderr: ${stderr}`)),
      10_000,
    );
    child.stdout.on("data", () => {
      const match = stdout.match(
        /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/#credential=[A-Za-z0-9_%_-]+)/,
      );
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Packed dashboard exited before startup with ${code}.`));
    });
  });

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Installed inventory/);
  assert.equal(stderr, "");
  if (expectDoctorSummary) {
    assert.match(stdout, /Providers: 1 detected, 4 unavailable/);
    assert.match(stdout, /Findings:/);
  }
  const exit = once(child, "exit");
  child.kill("SIGINT");
  const [exitCode] = await exit;
  assert.equal(exitCode, 0);
  assert.match(stdout, /Shutting down\./);
}

async function assertPublicPackageContents(
  installedPackageRoot: string,
): Promise<void> {
  const files = await regularFiles(installedPackageRoot);
  assert.deepEqual(
    files.map((file) => path.relative(installedPackageRoot, file)).sort(),
    expectedPackedFiles,
  );

  const forbiddenSecrets =
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
  const legacyMarkers = [
    "claude-md-manager",
    "CLAUDE.md Manager",
    "assets/screenshot.png",
    "claude-md-manager.py",
    "python3",
  ];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.equal(contents.includes(repositoryRoot), false, path.basename(file));
    assert.equal(contents.includes(os.homedir()), false, path.basename(file));
    assert.equal(contents.includes("fixture-sensitive"), false, path.basename(file));
    assert.equal(contents.includes("fixture-password"), false, path.basename(file));
    assert.equal(forbiddenSecrets.test(contents), false, path.basename(file));
    for (const marker of legacyMarkers) {
      assert.equal(contents.includes(marker), false, path.basename(file));
    }
  }
}

async function regularFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await regularFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await regularFiles(root)).sort()) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
