import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { CoordinatedScan } from "../core/coordinator.ts";
import {
  dashboardClientScript,
  dashboardDocument,
  dashboardStyles,
} from "../dashboard/dashboard.ts";
import { displayRelative, isWithin } from "../providers/shared.ts";
import {
  ActionError,
  LocalActionService,
  createActionInventory,
  type DetectedEditor,
  type SpawnProcess,
} from "./actions.ts";

const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export interface DashboardServer {
  host: "127.0.0.1";
  port: number;
  origin: string;
  url: string;
  credential: string;
  close(): Promise<void>;
}

interface WorkingDirectoryOption {
  id: string;
  canonicalPath: string;
  displayPath: string;
}

async function createWorkingDirectories(
  scan: CoordinatedScan,
): Promise<WorkingDirectoryOption[]> {
  const repositoryPath = await realpath(scan.context.repositoryPath);
  const candidates = new Set([
    repositoryPath,
    await realpath(scan.context.workingDirectory),
  ]);

  for (const snapshot of scan.snapshots) {
    for (const resource of snapshot.effective.resources) {
      if (resource.kind !== "instruction" || !resource.path) {
        continue;
      }
      const metadataDirectory =
        typeof resource.metadata.loadDirectory === "string"
          ? resource.metadata.loadDirectory
          : typeof resource.metadata.discoveredDirectory === "string"
            ? resource.metadata.discoveredDirectory
            : path.dirname(resource.path);
      try {
        const candidate = await realpath(metadataDirectory);
        if (isWithin(repositoryPath, candidate) && (await stat(candidate)).isDirectory()) {
          candidates.add(candidate);
        }
      } catch {
        continue;
      }
    }
  }

  return [...candidates]
    .map((canonicalPath) => ({
      id: randomBytes(18).toString("base64url"),
      canonicalPath,
      displayPath: displayRelative("$REPO", repositoryPath, canonicalPath),
    }))
    .sort((left, right) =>
      left.displayPath.localeCompare(right.displayPath),
    );
}

async function createLocalActions(
  scan: CoordinatedScan,
  host: string,
  editor: DetectedEditor | undefined,
  spawnProcess: SpawnProcess | undefined,
): Promise<LocalActionService> {
  const resources = scan.snapshots.flatMap(
    (snapshot) => snapshot.effective.resources,
  );
  const allowedRoots = [
    scan.context.repositoryPath,
    ...scan.snapshots.flatMap((snapshot) => snapshot.detection.configRoots),
  ];
  const inventory = await createActionInventory({ resources, allowedRoots });
  return new LocalActionService({
    bindingAddress: host,
    editor,
    inventory,
    platform: process.platform,
    ...(spawnProcess ? { spawnProcess } : {}),
  });
}

function publicDashboardOptions(
  state: {
    actions: LocalActionService;
    scannedAt: string;
    selectedWorkingDirectoryId: string;
  },
  workingDirectories: readonly WorkingDirectoryOption[],
  editor: DetectedEditor | undefined,
) {
  return {
    workingDirectories: workingDirectories.map(({ id, displayPath }) => ({
      id,
      displayPath,
    })),
    selectedWorkingDirectoryId: state.selectedWorkingDirectoryId,
    scannedAt: state.scannedAt,
    actionableResourceIds: state.actions.resourceIds(),
    editor: editor ? { id: editor.id, label: editor.label } : null,
  };
}

export async function startDashboardServer(options: {
  initialScan: CoordinatedScan;
  host?: string;
  port?: number;
  editor?: DetectedEditor;
  spawnProcess?: SpawnProcess;
  scanWorkingDirectory?: (workingDirectory: string) => Promise<CoordinatedScan>;
}): Promise<DashboardServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("Dashboard server must bind exclusively to 127.0.0.1.");
  }
  const credential = randomBytes(32).toString("base64url");
  const workingDirectories = await createWorkingDirectories(options.initialScan);
  const state = {
    actions: await createLocalActions(
      options.initialScan,
      host,
      options.editor,
      options.spawnProcess,
    ),
    currentScan: options.initialScan,
    repositoryPath: await realpath(options.initialScan.context.repositoryPath),
    scannedAt: new Date().toISOString(),
    selectedWorkingDirectoryId: workingDirectories.find(
      (entry) =>
        entry.canonicalPath === options.initialScan.context.workingDirectory,
    )?.id ?? workingDirectories[0]!.id,
  };
  let origin = "";

  const server = createServer(async (request, response) => {
    try {
      await routeRequest({
        credential,
        editor: options.editor,
        origin,
        request,
        response,
        scanWorkingDirectory: options.scanWorkingDirectory,
        spawnProcess: options.spawnProcess,
        state,
        workingDirectories,
      });
    } catch {
      sendJson(response, 500, {
        error: "internal_error",
        message: "The local dashboard could not complete the request.",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  origin = `http://${host}:${address.port}`;

  return {
    host,
    port: address.port,
    origin,
    url: `${origin}/#credential=${encodeURIComponent(credential)}`,
    credential,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

async function routeRequest(options: {
  credential: string;
  editor: DetectedEditor | undefined;
  origin: string;
  request: IncomingMessage;
  response: ServerResponse;
  scanWorkingDirectory:
    | ((workingDirectory: string) => Promise<CoordinatedScan>)
    | undefined;
  spawnProcess: SpawnProcess | undefined;
  state: {
    actions: LocalActionService;
    currentScan: CoordinatedScan;
    repositoryPath: string;
    scannedAt: string;
    selectedWorkingDirectoryId: string;
  };
  workingDirectories: WorkingDirectoryOption[];
}): Promise<void> {
  const {
    credential,
    editor,
    origin,
    request,
    response,
    scanWorkingDirectory,
    spawnProcess,
    state,
    workingDirectories,
  } = options;
  const requestUrl = new URL(request.url ?? "/", origin);
  setSecurityHeaders(response);

  if (request.method === "GET" && requestUrl.pathname === "/") {
    sendText(response, 200, "text/html; charset=utf-8", dashboardDocument());
    return;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/assets/dashboard.css"
  ) {
    sendText(response, 200, "text/css; charset=utf-8", dashboardStyles);
    return;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/assets/dashboard.js"
  ) {
    sendText(
      response,
      200,
      "text/javascript; charset=utf-8",
      dashboardClientScript,
    );
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (requestUrl.pathname.startsWith("/api/") && !isAuthorized(request, credential)) {
    sendJson(response, 401, {
      error: "unauthorized",
      message: "A valid local session credential is required.",
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/scan") {
    if (requestUrl.search !== "") {
      sendJson(response, 400, {
        error: "invalid_request",
        message: "Working directory changes require a protected action request.",
      });
      return;
    }
    sendJson(response, 200, state.currentScan.report);
    return;
  }

  if (
    request.method === "POST" &&
    requestUrl.pathname.startsWith("/api/actions/") &&
    request.headers.origin !== origin
  ) {
    sendJson(response, 403, {
      error: "invalid_origin",
      message: "The action request origin is not allowed.",
    });
    return;
  }

  if (
    request.method === "POST" &&
    requestUrl.pathname === "/api/actions/select-working-directory"
  ) {
    const body = await readJsonBody(request);
    if (!isWorkingDirectoryActionBody(body)) {
      sendJson(response, 400, {
        error: "invalid_request",
        message: "The action accepts one opaque working directory ID.",
      });
      return;
    }
    const selected = workingDirectories.find(
      (entry) => entry.id === body.workingDirectoryId,
    );
    if (!selected || !scanWorkingDirectory) {
      sendJson(response, 400, {
        error: "invalid_working_directory",
        message: "Select a working directory from the current dashboard session.",
      });
      return;
    }
    if (!(await isCurrentWorkingDirectory(selected, state.repositoryPath))) {
      sendJson(response, 409, {
        error: "working_directory_changed",
        message:
          "The selected working directory changed after startup. Relaunch Agent Config Doctor.",
      });
      return;
    }
    try {
      const nextScan = await scanWorkingDirectory(selected.canonicalPath);
      const nextActions = await createLocalActions(
        nextScan,
        "127.0.0.1",
        editor,
        spawnProcess,
      );
      state.currentScan = nextScan;
      state.actions = nextActions;
      state.scannedAt = new Date().toISOString();
      state.selectedWorkingDirectoryId = selected.id;
      sendJson(response, 200, {
        report: state.currentScan.report,
        options: publicDashboardOptions(
          state,
          workingDirectories,
          editor,
        ),
      });
    } catch {
      sendJson(response, 500, {
        error: "scan_failed",
        message: "The selected working directory could not be scanned.",
      });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/options") {
    sendJson(
      response,
      200,
      publicDashboardOptions(state, workingDirectories, editor),
    );
    return;
  }

  const resourcePathMatch = requestUrl.pathname.match(
    /^\/api\/resources\/([A-Za-z0-9_-]+)\/path$/,
  );
  if (request.method === "GET" && resourcePathMatch?.[1]) {
    try {
      sendJson(response, 200, {
        path: await state.actions.pathFor(resourcePathMatch[1]),
      });
    } catch (error) {
      sendActionError(response, error);
    }
    return;
  }

  if (
    request.method === "POST" &&
    (requestUrl.pathname === "/api/actions/open" ||
      requestUrl.pathname === "/api/actions/reveal")
  ) {
    const body = await readJsonBody(request);
    if (!isResourceActionBody(body)) {
      sendJson(response, 400, {
        error: "invalid_request",
        message: "The action accepts one opaque resource ID.",
      });
      return;
    }
    try {
      if (requestUrl.pathname.endsWith("/open")) {
        await state.actions.open(body.resourceId);
      } else {
        await state.actions.reveal(body.resourceId);
      }
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendActionError(response, error);
    }
    return;
  }

  sendJson(response, 404, {
    error: "not_found",
    message: "The requested local dashboard route does not exist.",
  });
}

async function isCurrentWorkingDirectory(
  selected: WorkingDirectoryOption,
  repositoryPath: string,
): Promise<boolean> {
  try {
    const currentPath = await realpath(selected.canonicalPath);
    return (
      currentPath === selected.canonicalPath &&
      isWithin(repositoryPath, currentPath) &&
      (await stat(currentPath)).isDirectory()
    );
  } catch {
    return false;
  }
}

function isAuthorized(request: IncomingMessage, credential: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) {
    return false;
  }
  const received = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(credential);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function isResourceActionBody(value: unknown): value is { resourceId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.resourceId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(record.resourceId)
  );
}

function isWorkingDirectoryActionBody(
  value: unknown,
): value is { workingDirectoryId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.workingDirectoryId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(record.workingDirectoryId)
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16 * 1024) {
      return undefined;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function sendActionError(response: ServerResponse, error: unknown): void {
  if (!(error instanceof ActionError)) {
    sendJson(response, 500, {
      error: "action_failed",
      message: "The local action could not be completed.",
    });
    return;
  }
  const status = error.code === "resource_not_found" ? 404 : 409;
  sendJson(response, status, { error: error.code, message: error.message });
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  sendText(response, status, "application/json; charset=utf-8", JSON.stringify(payload));
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  if (response.headersSent) {
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}
