import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ScanContext } from "./provider-adapter.ts";
import { scanProviders, type CoordinatedScan } from "./coordinator.ts";
import { ClaudeAdapter } from "../providers/claude.ts";
import { CodexAdapter } from "../providers/codex.ts";
import { GrokAdapter } from "../providers/grok.ts";
import { HermesAdapter } from "../providers/hermes.ts";
import { OpenCodeAdapter } from "../providers/opencode.ts";

export const providerAdapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GrokAdapter(),
  new OpenCodeAdapter(),
  new HermesAdapter(),
] as const;

export async function scanPath(selectedPath: string): Promise<CoordinatedScan> {
  const workingDirectory = await resolveSelectedDirectory(selectedPath);
  const repositoryPath = await findRepositoryRoot(workingDirectory);
  const context: ScanContext = {
    homeDirectory: os.homedir(),
    repositoryPath,
    workingDirectory,
    environment: process.env,
  };

  return scanProviders(providerAdapters, context);
}

async function resolveSelectedDirectory(selectedPath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(selectedPath));
  } catch {
    throw new Error("selected path does not exist.");
  }

  if (!(await stat(resolved)).isDirectory()) {
    throw new Error("selected path must be a directory.");
  }
  return resolved;
}

async function findRepositoryRoot(workingDirectory: string): Promise<string> {
  let current = workingDirectory;
  while (true) {
    try {
      await access(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return workingDirectory;
      }
      current = parent;
    }
  }
}
