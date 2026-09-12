/**
 * Configuration helpers shared by the OpenCode adapters: JSONC parsing,
 * home-relative path expansion, and MCP transport redaction.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ScanContext } from "../core/provider-adapter.ts";
import type { JsonValue } from "../core/schema.ts";
import { isRecord, sanitizeUrl, stringArray, stringValue } from "./shared.ts";

export async function readJsoncFile(
  candidate: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const stripped = stripJsonComments(await readFile(candidate, "utf8"));
    const parsed: unknown = JSON.parse(stripTrailingCommas(stripped));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stripJsonComments(contents: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < contents.length; index += 1) {
    const current = contents[index] ?? "";
    const next = contents[index + 1] ?? "";
    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < contents.length && contents[index] !== "\n") {
        index += 1;
      }
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (
        index < contents.length &&
        !(contents[index] === "*" && contents[index + 1] === "/")
      ) {
        result += contents[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
      continue;
    }
    result += current;
  }
  return result;
}

function stripTrailingCommas(contents: string): string {
  return contents.replace(/,\s*([}\]])/g, "$1");
}

export function sanitizeOpenCodeMcp(
  server: Record<string, unknown>,
): Record<string, JsonValue> {
  const type = stringValue(server.type) ?? "unknown";
  if (type === "local") {
    const command = stringArray(server.command);
    const environment = isRecord(server.environment) ? server.environment : {};
    return {
      transportType: "stdio",
      command: command[0] ?? "unknown",
      argumentCount: Math.max(command.length - 1, 0),
      environmentVariableNames: Object.keys(environment).sort(),
    };
  }
  const headers = isRecord(server.headers) ? server.headers : {};
  return {
    transportType: "http",
    url: sanitizeUrl(stringValue(server.url)),
    staticHeaderNames: Object.keys(headers).sort(),
  };
}

export function resolveConfigPath(
  configPath: string,
  configured: string,
  context: ScanContext,
): string {
  if (configured.startsWith("~/")) {
    return path.join(context.homeDirectory, configured.slice(2));
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(path.dirname(configPath), configured);
}

