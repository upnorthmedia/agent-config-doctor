#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CoordinatedScan } from "./core/coordinator.ts";
import { scanPath } from "./core/runtime.ts";
import { isInContext } from "./core/scanner.ts";
import { packageVersion } from "./core/version.ts";
import { detectGuiEditors, selectGuiEditor } from "./server/actions.ts";
import { startDashboardServer } from "./server/server.ts";

const help = `Agent Config Doctor

Inspect coding-agent instructions and extensions from one local tool.

Usage:
  agent-config-doctor [path] [--no-open] [--editor <name>]
  agent-config-doctor scan [path] --json
  agent-config-doctor doctor [path]

Options:
  -h, --help       Show help
  -v, --version    Print the package version and exit
  --no-open        Start the dashboard without opening a browser
  --editor <name>  Use a supported GUI editor
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  const command = argv[0];
  if (command === "scan") {
    return runScan(argv.slice(1));
  }
  if (command === "doctor") {
    return runDoctor(argv.slice(1));
  }
  return runDashboard(argv);
}

async function runScan(argv: string[]): Promise<number> {
  if (!argv.includes("--json")) {
    throw new Error("scan requires --json.");
  }
  const positional = argv.filter((argument) => argument !== "--json");
  if (positional.length > 1) {
    throw new Error("scan accepts at most one path.");
  }
  const scan = await scanPath(positional[0] ?? process.cwd());
  process.stdout.write(`${JSON.stringify(scan.report, null, 2)}\n`);
  writeNotices(scan, process.stderr);
  return 0;
}

function writeNotices(scan: CoordinatedScan, stream: NodeJS.WriteStream): void {
  for (const notice of scan.report.notices) {
    stream.write(
      `Notice (${notice.provider}, scan incomplete): ${notice.message}\n  ${notice.remediation}\n`,
    );
  }
}

async function runDoctor(argv: string[]): Promise<number> {
  if (argv.some((argument) => argument.startsWith("-"))) {
    throw new Error("doctor accepts only an optional path.");
  }
  if (argv.length > 1) {
    throw new Error("doctor accepts at most one path.");
  }
  const scan = await scanPath(argv[0] ?? process.cwd());
  writeDoctorSummary(scan);
  return serveDashboard(scan, { noOpen: true });
}

function writeDoctorSummary(scan: CoordinatedScan): void {
  const detected = scan.report.providers.filter((provider) => provider.installed).length;
  const unavailable = scan.report.providers.length - detected;
  const counts = { error: 0, warning: 0, info: 0 };
  let elsewhereFindings = 0;
  for (const finding of scan.report.findings) {
    if (isInContext(finding)) {
      counts[finding.severity] += 1;
    } else {
      elsewhereFindings += 1;
    }
  }
  const elsewhere = scan.report.resources.filter(
    (resource) => resource.reach === "repository",
  ).length;
  const installed = scan.report.resources.length - elsewhere;

  process.stdout.write(
    [
      "Agent Config Doctor",
      "",
      `Providers: ${detected} detected, ${unavailable} unavailable`,
      `Resources: ${installed} installed, ${elsewhere} elsewhere in repository`,
      `Findings: ${formatCount(counts.error, "error")}, ${formatCount(counts.warning, "warning")}, ${counts.info} info${elsewhereFindings > 0 ? ` (${elsewhereFindings} more elsewhere in repository)` : ""}`,
      `Scan: ${scan.report.notices.length === 0 ? "complete" : `incomplete, ${formatCount(scan.report.notices.length, "notice")}`}`,
      "",
    ].join("\n"),
  );
  writeNotices(scan, process.stdout);
  process.stdout.write("\n");
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

async function runDashboard(argv: string[]): Promise<number> {
  let noOpen = false;
  let editorOverride: string | undefined;
  let selectedPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--no-open") {
      noOpen = true;
      continue;
    }
    if (argument === "--editor") {
      editorOverride = argv[index + 1];
      if (!editorOverride) {
        throw new Error("--editor requires a supported editor name.");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--editor=")) {
      editorOverride = argument.slice("--editor=".length);
      if (!editorOverride) {
        throw new Error("--editor requires a supported editor name.");
      }
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option "${argument}".`);
    }
    if (selectedPath) {
      throw new Error("The dashboard accepts at most one path.");
    }
    selectedPath = argument;
  }

  const scan = await scanPath(selectedPath ?? process.cwd());
  return serveDashboard(scan, {
    noOpen,
    ...(editorOverride ? { editorOverride } : {}),
  });
}

async function serveDashboard(
  scan: CoordinatedScan,
  options: { editorOverride?: string; noOpen: boolean },
): Promise<number> {
  const editors = await detectGuiEditors();
  const editor = selectGuiEditor(options.editorOverride, editors);
  const server = await startDashboardServer({
    initialScan: scan,
    ...(editor ? { editor } : {}),
  });
  const shutdown = waitForShutdown();
  process.stdout.write(
    [
      "Agent Config Doctor",
      `Dashboard: ${server.url}`,
      `Editor: ${editor?.label ?? "not detected, copy path and reveal remain available"}`,
      "Press Ctrl-C to stop.",
      "",
    ].join("\n"),
  );
  if (!options.noOpen) {
    openBrowser(server.url);
  }
  await shutdown;
  await server.close();
  process.stdout.write("Shutting down.\n");
  return 0;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function openBrowser(url: string): void {
  const launcher =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? {
            command: "rundll32.exe",
            args: ["url.dll,FileProtocolHandler", url],
          }
        : { command: "xdg-open", args: [url] };
  const child = spawn(launcher.command, launcher.args, {
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  child.once("error", () => {});
  child.unref();
}

const isEntryPoint = (() => {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
