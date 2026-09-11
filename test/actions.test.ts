import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  ActionError,
  LocalActionService,
  createActionInventory,
  detectGuiEditors,
  selectGuiEditor,
  type SpawnProcess,
  type SpawnedProcess,
} from "../src/server/actions.ts";
import type { ResourceRecord } from "../src/core/schema.ts";

function resource(resourcePath: string): ResourceRecord {
  return {
    id: "opaque-resource-id",
    kind: "instruction",
    provider: "codex",
    providerVersion: "1.0.0",
    name: "AGENTS.md",
    scope: "project",
    origin: "project-instruction",
    owner: { type: "self" },
    path: resourcePath,
    displayPath: "$REPO/AGENTS.md",
    state: "active",
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: "$REPO/AGENTS.md",
    capabilities: [],
    metadata: { discoveredPath: resourcePath },
    findings: [],
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-config-actions-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-config-outside-"));
  const filePath = path.join(root, "AGENTS.md");
  await writeFile(filePath, "# Instructions\n", "utf8");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  return { filePath, outside, root };
}

function successfulProcess(): SpawnedProcess {
  const child = new EventEmitter() as EventEmitter & SpawnedProcess;
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("detects only allowlisted GUI editor executables", async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "agent-config-editors-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["code", "vim", "cursor"]) {
    const executable = path.join(bin, name);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
  }

  const editors = await detectGuiEditors({ pathValue: bin, platform: "darwin" });

  assert.deepEqual(
    editors.map((editor) => editor.id),
    ["code", "cursor"],
  );
  assert.throws(
    () => selectGuiEditor("vim", editors),
    /Unsupported editor "vim"/,
  );
  assert.equal(selectGuiEditor("cursor", editors)?.id, "cursor");
});

test("does not detect Windows command scripts that require a shell", async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "agent-config-editors-win-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of ["code.cmd", "cursor.bat", "zed.exe"]) {
    const executable = path.join(bin, name);
    await writeFile(executable, "fixture", "utf8");
    await chmod(executable, 0o755);
  }

  const editors = await detectGuiEditors({ pathValue: bin, platform: "win32" });

  assert.deepEqual(editors.map((editor) => editor.id), ["zed"]);
});

test("opens only current discovered files with argument arrays and no shell", async (t) => {
  const { filePath, root } = await fixture(t);
  const inventory = await createActionInventory({
    resources: [resource(filePath)],
    allowedRoots: [root],
  });
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: { detached: true; shell: false; stdio: "ignore" };
  }> = [];
  const spawnProcess: SpawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return successfulProcess();
  };
  const service = new LocalActionService({
    bindingAddress: "127.0.0.1",
    editor: {
      id: "code",
      label: "Visual Studio Code",
      executablePath: "/usr/local/bin/code",
    },
    inventory,
    platform: "darwin",
    spawnProcess,
  });

  await service.open("opaque-resource-id");
  await service.reveal("opaque-resource-id");
  const canonicalFilePath = await realpath(filePath);

  assert.deepEqual(calls, [
    {
      command: "/usr/local/bin/code",
      args: ["--goto", canonicalFilePath],
      options: { detached: true, shell: false, stdio: "ignore" },
    },
    {
      command: "open",
      args: ["-R", canonicalFilePath],
      options: { detached: true, shell: false, stdio: "ignore" },
    },
  ]);
  assert.equal(await service.pathFor("opaque-resource-id"), canonicalFilePath);
});

test("reports an editor process launch failure without crashing the server", async (t) => {
  const { filePath, root } = await fixture(t);
  const inventory = await createActionInventory({
    resources: [resource(filePath)],
    allowedRoots: [root],
  });
  const spawnProcess: SpawnProcess = () => {
    const child = new EventEmitter() as EventEmitter & SpawnedProcess;
    child.unref = () => {};
    queueMicrotask(() => child.emit("error", new Error("executable disappeared")));
    return child;
  };
  const service = new LocalActionService({
    bindingAddress: "127.0.0.1",
    editor: {
      id: "code",
      label: "Visual Studio Code",
      executablePath: "/missing/code",
    },
    inventory,
    platform: "darwin",
    spawnProcess,
  });

  await assert.rejects(
    service.open("opaque-resource-id"),
    (error: unknown) =>
      error instanceof ActionError && error.code === "launch_failed",
  );
});

test("rejects forged IDs and action services that are not exclusively loopback", async (t) => {
  const { filePath, root } = await fixture(t);
  const inventory = await createActionInventory({
    resources: [resource(filePath)],
    allowedRoots: [root],
  });

  assert.throws(
    () =>
      new LocalActionService({
        bindingAddress: "0.0.0.0",
        editor: undefined,
        inventory,
        platform: "darwin",
      }),
    /Local actions require an exclusive loopback binding/,
  );

  const service = new LocalActionService({
    bindingAddress: "127.0.0.1",
    editor: undefined,
    inventory,
    platform: "darwin",
  });
  await assert.rejects(
    service.pathFor("forged-resource-id"),
    (error: unknown) =>
      error instanceof ActionError && error.code === "resource_not_found",
  );
  await assert.rejects(
    service.open("opaque-resource-id"),
    (error: unknown) =>
      error instanceof ActionError && error.code === "editor_unavailable",
  );
});

test("rejects a file replaced after discovery", async (t) => {
  const { filePath, root } = await fixture(t);
  const inventory = await createActionInventory({
    resources: [resource(filePath)],
    allowedRoots: [root],
  });
  const service = new LocalActionService({
    bindingAddress: "127.0.0.1",
    editor: undefined,
    inventory,
    platform: "darwin",
  });
  await unlink(filePath);
  await writeFile(filePath, "# Replacement\n", "utf8");

  await assert.rejects(
    service.pathFor("opaque-resource-id"),
    (error: unknown) =>
      error instanceof ActionError && error.code === "resource_replaced",
  );
});

test("rejects a discovered symlink redirected outside its allowed root", async (t) => {
  const { filePath, outside, root } = await fixture(t);
  const linkPath = path.join(root, "linked.md");
  const outsidePath = path.join(outside, "outside.md");
  await writeFile(outsidePath, "# Outside\n", "utf8");
  await symlink(filePath, linkPath);
  const linkedResource = resource(filePath);
  linkedResource.id = "linked-resource-id";
  linkedResource.metadata.discoveredPath = linkPath;
  const inventory = await createActionInventory({
    resources: [linkedResource],
    allowedRoots: [root],
  });
  const service = new LocalActionService({
    bindingAddress: "127.0.0.1",
    editor: undefined,
    inventory,
    platform: "darwin",
  });
  await unlink(linkPath);
  await symlink(outsidePath, linkPath);

  await assert.rejects(
    service.pathFor("linked-resource-id"),
    (error: unknown) =>
      error instanceof ActionError && error.code === "resource_replaced",
  );
});
