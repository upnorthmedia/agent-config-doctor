import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { ScanContext } from "../core/provider-adapter.ts";
import type {
  JsonValue,
  ProviderId,
  ResourceKind,
  ResourceReach,
  ScanNotice,
} from "../core/schema.ts";

/**
 * Budget for one native inspection command. A cold provider start can take
 * several seconds (a cold `codex plugin list --json` was measured at about
 * 10.6 seconds), so the budget is generous and the command runs
 * asynchronously so other providers keep scanning meanwhile.
 */
export const NATIVE_COMMAND_TIMEOUT_MS = 15_000;

export interface CommandResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  spawnError?: string;
}

export function runCommand(
  executablePath: string,
  args: string[],
  context: ScanContext,
  timeout = context.nativeCommandTimeoutMs ?? NATIVE_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      executablePath,
      args,
      {
        cwd: context.workingDirectory,
        encoding: "utf8",
        env: { ...process.env, ...context.environment },
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        const output = typeof stdout === "string" ? stdout : "";
        if (!error) {
          resolve({ status: 0, stdout: output, timedOut: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (typeof failure.code === "string") {
          resolve({
            status: null,
            stdout: output,
            timedOut: false,
            spawnError: failure.code,
          });
          return;
        }
        resolve({
          status: typeof failure.code === "number" ? failure.code : null,
          stdout: output,
          timedOut: failure.killed === true && failure.signal === "SIGKILL",
        });
      },
    );
  });
}

export type NativeFailure =
  | "timeout"
  | "nonzero-exit"
  | "malformed-json"
  | "unavailable";

export type NativeJsonOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; failure: NativeFailure; detail: string };

/**
 * Runs a read-only native listing command and classifies every way it can
 * fail. Callers must never treat a failure as an empty successful result.
 */
export async function runNativeJson(
  executablePath: string | undefined,
  args: string[],
  context: ScanContext,
): Promise<NativeJsonOutcome> {
  if (!executablePath) {
    return { ok: false, failure: "unavailable", detail: "no executable path" };
  }
  const timeout = context.nativeCommandTimeoutMs ?? NATIVE_COMMAND_TIMEOUT_MS;
  const result = await runCommand(executablePath, args, context, timeout);
  if (result.spawnError) {
    return { ok: false, failure: "unavailable", detail: result.spawnError };
  }
  if (result.timedOut) {
    return {
      ok: false,
      failure: "timeout",
      detail: `no result within ${formatSeconds(timeout)}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      failure: "nonzero-exit",
      detail: `exit status ${result.status ?? "unknown"}`,
    };
  }
  try {
    return { ok: true, payload: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, failure: "malformed-json", detail: "output was not JSON" };
  }
}

export function nativeNotice(
  provider: ProviderId,
  command: string,
  outcome: Extract<NativeJsonOutcome, { ok: false }>,
  evidence: string,
): ScanNotice {
  const label = providerLabel(provider);
  const messages: Record<NativeFailure, string> = {
    timeout: `"${command}" timed out (${outcome.detail}). ${evidence} from this scan is incomplete.`,
    "nonzero-exit": `"${command}" failed (${outcome.detail}). ${evidence} from this scan is incomplete.`,
    "malformed-json": `"${command}" returned output that could not be parsed (${outcome.detail}). ${evidence} from this scan is incomplete.`,
    unavailable: `"${command}" could not be started (${outcome.detail}). ${evidence} from this scan is incomplete.`,
  };
  const remediations: Record<NativeFailure, string> = {
    timeout: `Rerun the scan (agent-config-doctor scan <path> --json, or relaunch the dashboard). A cold ${label} start can exceed the budget; confirm "${command}" completes in a terminal.`,
    "nonzero-exit": `Run "${command}" in a terminal to see the ${label} error, then rerun the scan.`,
    "malformed-json": `Run "${command}" in a terminal and check its output, then rerun the scan.`,
    unavailable: `Confirm the ${label} executable is on PATH and runnable, then rerun the scan.`,
  };
  return {
    code: `native.command.${outcome.failure}`,
    provider,
    command,
    message: messages[outcome.failure],
    remediation: remediations[outcome.failure],
  };
}

export function providerLabel(provider: ProviderId): string {
  return {
    claude: "Claude Code",
    codex: "Codex",
    grok: "Grok Build",
    opencode: "OpenCode",
    hermes: "Hermes",
  }[provider];
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

export function parseSemanticVersion(output: unknown): string {
  return typeof output === "string"
    ? output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? "unknown"
    : "unknown";
}

export async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export async function readJsonFile(candidate: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(candidate, "utf8"));
  } catch {
    return undefined;
  }
}

export async function readYamlFile(candidate: string): Promise<unknown> {
  try {
    return parseYaml(await readFile(candidate, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Directory names that the repository walker never descends into. They hold
 * version-control internals, dependency trees, or build output that no
 * supported provider reads configuration from.
 */
export const GENERATED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
]);

/**
 * The one shared recursive walker. It reports files accepted by the predicate,
 * skips generated directories, and does not follow directory symlinks so that
 * linked trees cannot create cycles or reach outside the walked root.
 */
export async function walkFiles(
  root: string,
  accept: (name: string, candidate: string) => boolean,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];

  for (const entry of entries) {
    if (GENERATED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(candidate, accept)));
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      accept(entry.name, candidate)
    ) {
      files.push(candidate);
    }
  }

  return files.sort();
}

export async function findNamedFiles(
  root: string,
  names: ReadonlySet<string>,
): Promise<string[]> {
  return walkFiles(root, (name) => names.has(name));
}

/**
 * Whether a repository directory belongs to the selected working directory's
 * real ancestor chain. Files outside that chain are still inventory, but they
 * are reported with `reach: "repository"` and never take part in the
 * effective configuration.
 */
export function reachForDirectory(
  directory: string,
  context: ScanContext,
): ResourceReach {
  if (!isWithin(context.repositoryPath, directory)) {
    return "chain";
  }
  const resolved = path.resolve(directory);
  return directoriesFromRoot(context.repositoryPath, context.workingDirectory)
    .some((candidate) => candidate === resolved)
    ? "chain"
    : "repository";
}

export async function findSkillFiles(root: string): Promise<string[]> {
  return findNamedFiles(root, new Set(["SKILL.md"]));
}

export async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function resourceId(
  provider: ProviderId,
  kind: ResourceKind,
  identity: string,
): string {
  return createHash("sha256")
    .update(`${provider}\0${kind}\0${identity}`)
    .digest("hex")
    .slice(0, 20);
}

export function directoriesFromRoot(
  root: string,
  workingDirectory: string,
): string[] {
  const resolvedRoot = path.resolve(root);
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  if (!isWithin(resolvedRoot, resolvedWorkingDirectory)) {
    return [];
  }
  const relative = path.relative(resolvedRoot, resolvedWorkingDirectory);
  const segments = relative ? relative.split(path.sep) : [];
  return [
    resolvedRoot,
    ...segments.map((_, index) =>
      path.join(resolvedRoot, ...segments.slice(0, index + 1)),
    ),
  ];
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function displayPath(
  candidate: string,
  context: ScanContext,
  roots: ReadonlyArray<readonly [string, string]> = [],
): string {
  for (const [label, root] of roots) {
    if (isWithin(root, candidate)) {
      return displayRelative(label, root, candidate);
    }
  }
  if (isWithin(context.repositoryPath, candidate)) {
    return displayRelative("$REPO", context.repositoryPath, candidate);
  }
  if (isWithin(context.homeDirectory, candidate)) {
    return displayRelative("$HOME", context.homeDirectory, candidate);
  }
  return `<external>/${path.basename(candidate)}`;
}

export function displayRelative(
  label: string,
  root: string,
  candidate: string,
): string {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  return relative ? `${label}/${relative}` : label;
}

export function parseSkillFrontmatter(contents: string): {
  name?: string;
  description?: string;
  error?: string;
  metadata?: Record<string, unknown>;
} {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    return { error: "SKILL.md must begin with YAML frontmatter." };
  }
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (!isRecord(parsed)) {
      return { error: "SKILL.md frontmatter must be a YAML object." };
    }
    const name = stringValue(parsed.name);
    const description = stringValue(parsed.description);
    if (!name || !description) {
      return { error: "SKILL.md frontmatter requires name and description." };
    }
    return { name, description, metadata: parsed };
  } catch {
    return { error: "SKILL.md frontmatter is not valid YAML." };
  }
}

export function sanitizeTransport(
  raw: Record<string, unknown>,
): Record<string, JsonValue> {
  const transportType =
    stringValue(raw.type) ??
    stringValue(raw.transport) ??
    (typeof raw.command === "string" ? "stdio" : "http");
  const metadata: Record<string, JsonValue> = { transportType };

  if (transportType === "stdio") {
    const environment = isRecord(raw.env) ? raw.env : {};
    metadata.command = stringValue(raw.command) ?? "unknown";
    metadata.argumentCount = Array.isArray(raw.args) ? raw.args.length : 0;
    metadata.environmentVariableNames = Object.keys(environment).sort();
    return metadata;
  }

  metadata.url = sanitizeUrl(stringValue(raw.url) ?? stringValue(raw.target));
  const headers = isRecord(raw.headers)
    ? raw.headers
    : isRecord(raw.http_headers)
      ? raw.http_headers
      : {};
  metadata.staticHeaderNames = Object.keys(headers).sort();
  return metadata;
}

export function sanitizeUrl(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "unknown";
  }
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "redacted-invalid-url";
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
