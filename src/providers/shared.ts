import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { ScanContext } from "../core/provider-adapter.ts";
import type {
  JsonValue,
  ProviderId,
  ResourceKind,
} from "../core/schema.ts";

export interface CommandResult {
  status: number | null;
  stdout: string;
}

export function runCommand(
  executablePath: string,
  args: string[],
  context: ScanContext,
  timeout = 5_000,
): CommandResult {
  const result = spawnSync(executablePath, args, {
    cwd: context.workingDirectory,
    encoding: "utf8",
    env: { ...process.env, ...context.environment },
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

export function runJsonCommand(
  executablePath: string | undefined,
  args: string[],
  context: ScanContext,
): unknown {
  if (!executablePath) {
    return undefined;
  }
  const result = runCommand(executablePath, args, context);
  if (result.status !== 0) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
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

export async function findNamedFiles(
  root: string,
  names: ReadonlySet<string>,
): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await findNamedFiles(candidate, names)));
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        names.has(entry.name)
      ) {
        files.push(candidate);
      }
    }

    return files.sort();
  } catch {
    return [];
  }
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
