import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ResourceRecord } from "../core/schema.ts";
import { isWithin } from "../providers/shared.ts";

const editorDefinitions = [
  { id: "code", label: "Visual Studio Code", command: "code" },
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "subl", label: "Sublime Text", command: "subl" },
] as const;

export type EditorId = (typeof editorDefinitions)[number]["id"];

export interface DetectedEditor {
  id: EditorId;
  label: string;
  executablePath: string;
}

export interface SpawnedProcess {
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

interface ActionRoot {
  sourcePath: string;
  canonicalPath: string;
}

interface ActionTarget {
  id: string;
  discoveredPath: string;
  canonicalPath: string;
  device: bigint;
  inode: bigint;
  roots: ActionRoot[];
}

export interface ActionInventory {
  targets: ReadonlyMap<string, ActionTarget>;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { detached: true; shell: false; stdio: "ignore" },
) => SpawnedProcess;

export class ActionError extends Error {
  readonly code:
    | "editor_unavailable"
    | "resource_missing"
    | "resource_not_found"
    | "resource_outside_allowed_roots"
    | "resource_replaced"
    | "launch_failed";

  constructor(
    code:
      | "editor_unavailable"
      | "resource_missing"
      | "resource_not_found"
      | "resource_outside_allowed_roots"
      | "resource_replaced"
      | "launch_failed",
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}

export async function detectGuiEditors(options: {
  pathValue?: string;
  platform?: NodeJS.Platform;
} = {}): Promise<DetectedEditor[]> {
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32" ? [".exe", ""] : [""];
  const detected: DetectedEditor[] = [];

  for (const definition of editorDefinitions) {
    const executablePath = await findExecutable(
      directories,
      definition.command,
      extensions,
    );
    if (executablePath) {
      detected.push({
        id: definition.id,
        label: definition.label,
        executablePath,
      });
    }
  }
  return detected;
}

export function selectGuiEditor(
  override: string | undefined,
  editors: readonly DetectedEditor[],
): DetectedEditor | undefined {
  if (override === undefined) {
    return editors[0];
  }
  if (!editorDefinitions.some((definition) => definition.id === override)) {
    throw new Error(`Unsupported editor "${override}".`);
  }
  const editor = editors.find((candidate) => candidate.id === override);
  if (!editor) {
    throw new Error(`Editor "${override}" is not available.`);
  }
  return editor;
}

async function findExecutable(
  directories: readonly string[],
  command: string,
  extensions: readonly string[],
): Promise<string | undefined> {
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export async function createActionInventory(options: {
  resources: readonly ResourceRecord[];
  allowedRoots: readonly string[];
}): Promise<ActionInventory> {
  const roots = (
    await Promise.all(
      options.allowedRoots.map(async (sourcePath): Promise<ActionRoot | undefined> => {
        try {
          return {
            sourcePath: path.resolve(sourcePath),
            canonicalPath: await realpath(sourcePath),
          };
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((root): root is ActionRoot => root !== undefined);
  const targets = new Map<string, ActionTarget>();

  for (const resource of options.resources) {
    if (!resource.path) {
      continue;
    }
    const discoveredPathValue = resource.metadata.discoveredPath;
    const discoveredPath =
      typeof discoveredPathValue === "string"
        ? path.resolve(discoveredPathValue)
        : path.resolve(resource.path);
    try {
      const canonicalPath = await realpath(discoveredPath);
      const recordedCanonicalPath = await realpath(resource.path);
      const file = await stat(discoveredPath, { bigint: true });
      if (!file.isFile() || canonicalPath !== recordedCanonicalPath) {
        continue;
      }
      const containingRoots = roots.filter(
        (root) =>
          isWithin(root.sourcePath, discoveredPath) &&
          isWithin(root.canonicalPath, canonicalPath),
      );
      if (containingRoots.length === 0) {
        continue;
      }
      targets.set(resource.id, {
        id: resource.id,
        discoveredPath,
        canonicalPath,
        device: file.dev,
        inode: file.ino,
        roots: containingRoots,
      });
    } catch {
      continue;
    }
  }

  return { targets };
}

export class LocalActionService {
  readonly #editor: DetectedEditor | undefined;
  readonly #inventory: ActionInventory;
  readonly #platform: NodeJS.Platform;
  readonly #spawnProcess: SpawnProcess;

  constructor(options: {
    bindingAddress: string;
    editor: DetectedEditor | undefined;
    inventory: ActionInventory;
    platform: NodeJS.Platform;
    spawnProcess?: SpawnProcess;
  }) {
    if (options.bindingAddress !== "127.0.0.1") {
      throw new Error("Local actions require an exclusive loopback binding.");
    }
    this.#editor = options.editor;
    this.#inventory = options.inventory;
    this.#platform = options.platform;
    this.#spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  async pathFor(resourceId: string): Promise<string> {
    return (await this.#validate(resourceId)).canonicalPath;
  }

  resourceIds(): string[] {
    return [...this.#inventory.targets.keys()].sort();
  }

  async open(resourceId: string): Promise<void> {
    if (!this.#editor) {
      throw new ActionError(
        "editor_unavailable",
        "No supported GUI editor is available.",
      );
    }
    const target = await this.#validate(resourceId);
    const args =
      this.#editor.id === "code" || this.#editor.id === "cursor"
        ? ["--goto", target.canonicalPath]
        : [target.canonicalPath];
    await this.#launch(this.#editor.executablePath, args);
  }

  async reveal(resourceId: string): Promise<void> {
    const target = await this.#validate(resourceId);
    if (this.#platform === "darwin") {
      await this.#launch("open", ["-R", target.canonicalPath]);
      return;
    }
    if (this.#platform === "win32") {
      await this.#launch("explorer.exe", [`/select,${target.canonicalPath}`]);
      return;
    }
    await this.#launch("xdg-open", [path.dirname(target.canonicalPath)]);
  }

  async #launch(command: string, args: readonly string[]): Promise<void> {
    let child: SpawnedProcess;
    try {
      child = this.#spawnProcess(command, args, {
        detached: true,
        shell: false,
        stdio: "ignore",
      });
    } catch {
      throw launchError();
    }

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(launchError()));
      child.unref();
    });
  }

  async #validate(resourceId: string): Promise<ActionTarget> {
    const target = this.#inventory.targets.get(resourceId);
    if (!target) {
      throw new ActionError(
        "resource_not_found",
        "The resource is not in the current inventory.",
      );
    }

    let canonicalPath: string;
    let file: Awaited<ReturnType<typeof stat>>;
    try {
      canonicalPath = await realpath(target.discoveredPath);
      file = await stat(target.discoveredPath, { bigint: true });
    } catch {
      throw new ActionError(
        "resource_missing",
        "The discovered resource no longer exists.",
      );
    }

    if (
      !file.isFile() ||
      canonicalPath !== target.canonicalPath ||
      file.dev !== target.device ||
      file.ino !== target.inode
    ) {
      throw new ActionError(
        "resource_replaced",
        "The discovered resource changed after the scan. Scan again before opening it.",
      );
    }

    const isStillContained = (
      await Promise.all(
        target.roots.map(async (root) => {
          try {
            const currentRoot = await realpath(root.sourcePath);
            return (
              currentRoot === root.canonicalPath &&
              isWithin(root.sourcePath, target.discoveredPath) &&
              isWithin(currentRoot, canonicalPath)
            );
          } catch {
            return false;
          }
        }),
      )
    ).some(Boolean);
    if (!isStillContained) {
      throw new ActionError(
        "resource_outside_allowed_roots",
        "The discovered resource is outside the allowed roots.",
      );
    }

    return target;
  }
}

function launchError(): ActionError {
  return new ActionError(
    "launch_failed",
    "The local application could not be launched.",
  );
}

const defaultSpawnProcess: SpawnProcess = (command, args, options) =>
  spawn(command, args, options) as SpawnedProcess;
