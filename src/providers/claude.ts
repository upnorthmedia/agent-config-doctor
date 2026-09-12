import { readFile } from "node:fs/promises";
import path from "node:path";

import { SCHEMA_VERSION } from "../core/schema.ts";
import type {
  AdapterCapabilities,
  ProviderAdapter,
  ProviderDetection,
  ScanContext,
} from "../core/provider-adapter.ts";
import type {
  EffectiveConfiguration,
  Finding,
  ResourceRecord,
  ResourceScope,
  ResourceState,
} from "../core/schema.ts";
import {
  canonicalPath,
  directoriesFromRoot,
  displayPath,
  findNamedFiles,
  findSkillFiles,
  isDirectory,
  isFile,
  isRecord,
  parseSemanticVersion,
  parseSkillFrontmatter,
  reachForDirectory,
  readJsonFile,
  resourceId,
  runCommand,
  runJsonCommand,
  sanitizeTransport,
  stringArray,
  stringValue,
} from "./shared.ts";

const INSTRUCTION_NAMES = new Set(["CLAUDE.md", "CLAUDE.local.md"]);

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly capabilities: AdapterCapabilities = {
    resourceKinds: ["instruction", "skill", "plugin", "mcp"],
    nativeInspection: true,
  };

  async detect(context: ScanContext): Promise<ProviderDetection> {
    const executablePath = context.executables?.claude ?? "claude";
    const result = runCommand(executablePath, ["--version"], context, 2_000);
    const version = parseSemanticVersion(result.stdout);
    const installed = result.status === 0;
    const adminRoot = context.adminRoots?.claude ?? defaultAdminRoot();
    const userRoot = path.join(context.homeDirectory, ".claude");
    const projectRoot = path.join(context.repositoryPath, ".claude");
    const configRoots = [adminRoot, userRoot];
    if (await isDirectory(projectRoot)) {
      configRoots.push(projectRoot);
    }

    return {
      provider: this.provider,
      installed,
      version,
      support: !installed
        ? "unavailable"
        : /^2\.1\./.test(version)
          ? "supported"
          : "unsupported",
      executablePath,
      configRoots,
    };
  }

  async discover(
    context: ScanContext,
    detection: ProviderDetection,
  ): Promise<ResourceRecord[]> {
    if (detection.support !== "supported") {
      return [];
    }
    const adminRoot = context.adminRoots?.claude ?? defaultAdminRoot();
    const userRoot = path.join(context.homeDirectory, ".claude");
    const roots = claudeDisplayRoots(adminRoot);
    const instructions = await discoverInstructions(
      context,
      detection.version,
      adminRoot,
      userRoot,
      roots,
    );
    const skills = await discoverSkills(
      context,
      detection.version,
      adminRoot,
      userRoot,
      roots,
    );
    const plugins = await discoverPlugins(context, detection, roots);
    const mcps = await discoverMcpServers(
      context,
      detection.version,
      roots,
    );

    return [...instructions, ...skills, ...plugins, ...mcps].sort(compareResources);
  }

  async resolveEffective(
    context: ScanContext,
    resources: ResourceRecord[],
    detection: ProviderDetection,
  ): Promise<EffectiveConfiguration> {
    const resolved = resources.map((resource) => ({
      ...resource,
      precedence: { ...resource.precedence },
      state:
        resource.kind === "instruction" && resource.state !== "unavailable"
          ? ("inactive" as const)
          : resource.state,
    }));
    const orderedResourceIds: string[] = [];
    let order = 0;

    const activate = (resource: ResourceRecord): void => {
      if (resource.state === "unavailable" || resource.state === "invalid") {
        return;
      }
      resource.state = "active";
      resource.precedence = { ...resource.precedence, chainOrder: order };
      orderedResourceIds.push(resource.id);
      order += 1;
      for (const imported of resolved.filter(
        (candidate) =>
          candidate.kind === "instruction" &&
          candidate.metadata.importedBy === resource.id,
      )) {
        activate(imported);
      }
    };

    for (const scope of ["managed", "user"] as const) {
      for (const resource of resolved.filter(
        (candidate) =>
          candidate.kind === "instruction" &&
          candidate.scope === scope &&
          candidate.origin !== "instruction-import",
      )) {
        activate(resource);
      }
    }

    for (const directory of directoriesFromRoot(
      context.repositoryPath,
      context.workingDirectory,
    )) {
      for (const resource of resolved
        .filter(
          (candidate) =>
            candidate.kind === "instruction" &&
            (candidate.scope === "project" || candidate.scope === "local") &&
            candidate.origin !== "instruction-import" &&
            candidate.metadata.loadDirectory === directory,
        )
        .sort((left, right) => instructionRank(left) - instructionRank(right))) {
        activate(resource);
      }
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      provider: this.provider,
      providerVersion: detection.version,
      repositoryPath: context.repositoryPath,
      workingDirectory: context.workingDirectory,
      orderedResourceIds,
      resources: resolved,
      decisions: resolved.map((resource) => ({
        resourceId: resource.id,
        state: resource.state,
        ...(typeof resource.precedence.chainOrder === "number"
          ? { order: resource.precedence.chainOrder }
          : {}),
        reason: this.explain(resource),
      })),
    };
  }

  async validate(
    _context: ScanContext,
    resources: ResourceRecord[],
  ): Promise<Finding[]> {
    return resources.flatMap((resource) => resource.findings);
  }

  explain(resource: ResourceRecord): string {
    if (resource.state === "unavailable") {
      return "The imported instruction target is missing or unreadable.";
    }
    if (resource.state === "invalid") {
      return "The resource failed deterministic validation.";
    }
    if (resource.state === "disabled") {
      return "The resource is installed but disabled.";
    }
    if (resource.state === "shadowed") {
      return "A higher-precedence resource with the same identity is active.";
    }
    if (resource.state === "active") {
      return resource.kind === "instruction"
        ? "Loaded in the effective Claude Code instruction chain."
        : "Available in the effective Claude Code configuration.";
    }
    return "Installed, but outside the effective configuration for this working directory.";
  }
}

function defaultAdminRoot(): string {
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\ClaudeCode";
  }
  return "/etc/claude-code";
}

function claudeDisplayRoots(
  adminRoot: string,
): ReadonlyArray<readonly [string, string]> {
  return [["$ADMIN", adminRoot]];
}

async function discoverInstructions(
  context: ScanContext,
  providerVersion: string,
  adminRoot: string,
  userRoot: string,
  roots: ReadonlyArray<readonly [string, string]>,
): Promise<ResourceRecord[]> {
  const candidates = [
    path.join(adminRoot, "CLAUDE.md"),
    path.join(userRoot, "CLAUDE.md"),
    ...(await findNamedFiles(context.repositoryPath, INSTRUCTION_NAMES)),
  ];
  const resources: ResourceRecord[] = [];

  for (const candidate of candidates) {
    if (!(await isFile(candidate))) {
      continue;
    }
    resources.push(
      await createInstructionResource(
        candidate,
        context,
        providerVersion,
        adminRoot,
        userRoot,
        roots,
      ),
    );
  }

  for (const resource of [...resources]) {
    if (!resource.path) {
      continue;
    }
    resources.push(
      ...(await discoverImports(
        resource,
        context,
        providerVersion,
        roots,
        1,
        new Set([resource.path]),
      )),
    );
  }

  return [...new Map(resources.map((resource) => [resource.id, resource])).values()];
}

async function createInstructionResource(
  candidate: string,
  context: ScanContext,
  providerVersion: string,
  adminRoot: string,
  userRoot: string,
  roots: ReadonlyArray<readonly [string, string]>,
): Promise<ResourceRecord> {
  const contents = await readFile(candidate, "utf8");
  const shownPath = displayPath(candidate, context, roots);
  const inAdmin = candidate.startsWith(adminRoot);
  const inUser = candidate.startsWith(userRoot);
  const local = path.basename(candidate) === "CLAUDE.local.md";
  const loadDirectory =
    path.basename(path.dirname(candidate)) === ".claude"
      ? path.dirname(path.dirname(candidate))
      : path.dirname(candidate);

  return {
    id: resourceId("claude", "instruction", shownPath),
    kind: "instruction",
    provider: "claude",
    providerVersion,
    name: path.basename(candidate),
    scope: inAdmin ? "managed" : inUser ? "user" : local ? "local" : "project",
    origin: inAdmin
      ? "managed-instruction"
      : inUser
        ? "claude-user"
        : local
          ? "claude-local"
          : "repository",
    owner: inAdmin ? { type: "administrator" } : { type: "self" },
    path: await canonicalPath(candidate),
    displayPath: shownPath,
    reach: inAdmin || inUser ? "chain" : reachForDirectory(loadDirectory, context),
    state: "inactive",
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${shownPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      byteLength: Buffer.byteLength(contents),
      loadDirectory,
    },
    findings: [],
  };
}

async function discoverImports(
  parent: ResourceRecord,
  context: ScanContext,
  providerVersion: string,
  roots: ReadonlyArray<readonly [string, string]>,
  depth: number,
  visited: Set<string>,
): Promise<ResourceRecord[]> {
  if (!parent.path || depth > 4) {
    return [];
  }
  const contents = await readFile(parent.path, "utf8");
  const resources: ResourceRecord[] = [];

  for (const reference of parseImports(contents)) {
    const expanded = reference.startsWith("~/")
      ? path.join(context.homeDirectory, reference.slice(2))
      : reference.startsWith("/")
        ? reference
        : path.resolve(path.dirname(parent.path), reference);
    const shownPath = displayPath(expanded, context, roots);
    const id = resourceId("claude", "instruction", shownPath);

    if (!(await isFile(expanded))) {
      resources.push({
        id,
        kind: "instruction",
        provider: "claude",
        providerVersion,
        name: path.basename(expanded),
        scope: parent.scope,
        origin: "instruction-import",
        owner: parent.owner,
        displayPath: shownPath,
        ...(parent.reach ? { reach: parent.reach } : {}),
        state: "unavailable",
        precedence: {},
        evidenceType: "parsed",
        evidenceReceipt: `reference:${parent.displayPath ?? parent.name}`,
        capabilities: ["inspect"],
        metadata: {
          importedBy: parent.id,
          importDepth: depth,
        },
        findings: [
          {
            code: "claude.instruction.broken-import",
            severity: "error",
            confidence: "high",
            message: `Imported instruction ${shownPath} is missing or unreadable.`,
            resourceId: id,
          },
        ],
      });
      continue;
    }

    const canonical = await canonicalPath(expanded);
    if (visited.has(canonical)) {
      continue;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(canonical);
    const imported: ResourceRecord = {
      id,
      kind: "instruction",
      provider: "claude",
      providerVersion,
      name: path.basename(expanded),
      scope: parent.scope,
      origin: "instruction-import",
      owner: parent.owner,
      path: canonical,
      displayPath: shownPath,
      ...(parent.reach ? { reach: parent.reach } : {}),
      state: "inactive",
      precedence: {},
      evidenceType: "parsed",
      evidenceReceipt: `file:${shownPath}`,
      capabilities: ["inspect", "open"],
      metadata: {
        importedBy: parent.id,
        importDepth: depth,
        canonicalAgentsPointer: path.basename(expanded) === "AGENTS.md",
      },
      findings: [],
    };
    resources.push(imported);
    resources.push(
      ...(await discoverImports(
        imported,
        context,
        providerVersion,
        roots,
        depth + 1,
        nextVisited,
      )),
    );
  }

  return resources;
}

function parseImports(contents: string): string[] {
  const imports: string[] = [];
  let inFence = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    for (const match of line.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      if (match[1]) {
        imports.push(match[1].replace(/[),.;:]+$/, ""));
      }
    }
  }
  return imports;
}

async function discoverSkills(
  context: ScanContext,
  providerVersion: string,
  adminRoot: string,
  userRoot: string,
  roots: ReadonlyArray<readonly [string, string]>,
): Promise<ResourceRecord[]> {
  const chain = directoriesFromRoot(context.repositoryPath, context.workingDirectory);
  const locations: Array<{
    skillPath: string;
    scope: ResourceScope;
    origin: string;
    rank: number;
    eligible: boolean;
    owner: ResourceRecord["owner"];
    reach?: ResourceRecord["reach"];
  }> = [];

  for (const skillPath of await findSkillFiles(path.join(adminRoot, "skills"))) {
    locations.push({
      skillPath,
      scope: "managed",
      origin: "claude-managed",
      rank: 400,
      eligible: true,
      owner: { type: "administrator" },
    });
  }
  for (const skillPath of await findSkillFiles(path.join(userRoot, "skills"))) {
    locations.push({
      skillPath,
      scope: "user",
      origin: "claude-user",
      rank: 300,
      eligible: true,
      owner: { type: "self" },
    });
  }
  for (const skillPath of await findSkillFiles(context.repositoryPath)) {
    const scopeDirectory = claudeSkillScopeDirectory(skillPath);
    if (!scopeDirectory) {
      continue;
    }
    const depth = chain.indexOf(scopeDirectory);
    locations.push({
      skillPath,
      scope: "project",
      origin: "claude-project",
      rank: 100 + Math.max(depth, 0),
      eligible: depth >= 0,
      owner: { type: "self" },
      reach: reachForDirectory(scopeDirectory, context),
    });
  }

  const resources = await Promise.all(
    locations.map(async (location) => ({
      resource: await createSkillResource(
        location.skillPath,
        context,
        providerVersion,
        roots,
        location.scope,
        location.origin,
        location.owner,
        location.eligible ? "active" : "inactive",
        location.reach,
      ),
      rank: location.rank,
      eligible: location.eligible,
    })),
  );
  resolveNamedPrecedence(resources);
  return resources.map(({ resource }) => resource);
}

function claudeSkillScopeDirectory(skillPath: string): string | undefined {
  const marker = `${path.sep}.claude${path.sep}skills${path.sep}`;
  const index = path.resolve(skillPath).lastIndexOf(marker);
  return index >= 0 ? path.resolve(skillPath).slice(0, index) || path.sep : undefined;
}

async function createSkillResource(
  skillPath: string,
  context: ScanContext,
  providerVersion: string,
  roots: ReadonlyArray<readonly [string, string]>,
  scope: ResourceScope,
  origin: string,
  owner: ResourceRecord["owner"],
  state: ResourceState,
  reach?: ResourceRecord["reach"],
): Promise<ResourceRecord> {
  const contents = await readFile(skillPath, "utf8");
  const parsed = parseSkillFrontmatter(contents);
  const name = parsed.name ?? path.basename(path.dirname(skillPath));
  const shownPath = displayPath(skillPath, context, roots);
  const id = resourceId("claude", "skill", `${owner.id ?? owner.type}:${shownPath}`);
  const findings: Finding[] = parsed.error
    ? [
        {
          code: "claude.skill.invalid-frontmatter",
          severity: "error",
          confidence: "high",
          message: parsed.error,
          resourceId: id,
        },
      ]
    : [];

  return {
    id,
    kind: "skill",
    provider: "claude",
    providerVersion,
    name,
    scope,
    origin,
    owner,
    path: await canonicalPath(skillPath),
    displayPath: shownPath,
    ...(reach ? { reach } : {}),
    state: findings.length > 0 ? "invalid" : state,
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${shownPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      description: parsed.description ?? "",
    },
    findings,
  };
}

async function discoverPlugins(
  context: ScanContext,
  detection: ProviderDetection,
  roots: ReadonlyArray<readonly [string, string]>,
): Promise<ResourceRecord[]> {
  const payload = runJsonCommand(
    detection.executablePath,
    ["plugin", "list", "--json"],
    context,
  );
  if (!Array.isArray(payload)) {
    return [];
  }
  const rows: Array<{
    identity: string;
    rank: number;
    plugin: ResourceRecord;
    components: ResourceRecord[];
  }> = [];

  for (const rawPlugin of payload) {
    if (!isRecord(rawPlugin)) {
      continue;
    }
    const pluginId = stringValue(rawPlugin.id);
    const installPath = stringValue(rawPlugin.installPath);
    if (!pluginId || !installPath) {
      continue;
    }
    const name = pluginId.split("@")[0] ?? pluginId;
    const scope = claudeScope(rawPlugin.scope);
    const shownPath = displayPath(installPath, context, roots);
    const state: ResourceState = rawPlugin.enabled === false ? "disabled" : "active";
    const plugin: ResourceRecord = {
      id: resourceId("claude", "plugin", `${pluginId}:${scope}:${shownPath}`),
      kind: "plugin",
      provider: "claude",
      providerVersion: detection.version,
      name,
      scope,
      origin: "claude-plugin",
      owner: scope === "managed" ? { type: "administrator" } : { type: "self" },
      path: await canonicalPath(installPath),
      displayPath: shownPath,
      state,
      precedence: {},
      evidenceType: "native",
      evidenceReceipt: "command:claude plugin list --json",
      capabilities: ["inspect"],
      metadata: {
        version: stringValue(rawPlugin.version) ?? "unknown",
        dependencies: stringArray(rawPlugin.dependencies),
        hasPersistedDataPath: typeof rawPlugin.dataPath === "string",
      },
      findings: [],
    };
    const components: ResourceRecord[] = [];

    for (const skillPath of await findSkillFiles(path.join(installPath, "skills"))) {
      components.push(
        await createSkillResource(
          skillPath,
          context,
          detection.version,
          roots,
          "bundled",
          "plugin",
          { type: "plugin", id: pluginId },
          state,
        ),
      );
    }

    const mcpServers = isRecord(rawPlugin.mcpServers) ? rawPlugin.mcpServers : {};
    for (const [serverName, rawServer] of Object.entries(mcpServers)) {
      if (!isRecord(rawServer)) {
        continue;
      }
      components.push({
        id: resourceId(
          "claude",
          "mcp",
          `${pluginId}:${scope}:${serverName}:${shownPath}`,
        ),
        kind: "mcp",
        provider: "claude",
        providerVersion: detection.version,
        name: serverName,
        scope: "bundled",
        origin: "plugin",
        owner: { type: "plugin", id: pluginId },
        path: await canonicalPath(installPath),
        displayPath: shownPath,
        state,
        precedence: {},
        evidenceType: "native",
        evidenceReceipt: "command:claude plugin list --json",
        capabilities: ["inspect"],
        metadata: sanitizeTransport(rawServer),
        findings: [],
      });
    }

    rows.push({
      identity: pluginId,
      rank: claudePluginScopeRank(scope),
      plugin,
      components,
    });
  }

  for (const identity of new Set(rows.map((row) => row.identity))) {
    const candidates = rows
      .filter((row) => row.identity === identity)
      .sort(
        (left, right) =>
          right.rank - left.rank || compareResources(left.plugin, right.plugin),
      );
    const winner = candidates[0];
    if (!winner) {
      continue;
    }
    for (const candidate of candidates.slice(1)) {
      candidate.plugin.state = "shadowed";
      candidate.plugin.precedence = { shadowedBy: winner.plugin.id };
      for (const component of candidate.components) {
        component.state = "shadowed";
        const winningComponent = winner.components.find(
          (resource) =>
            resource.kind === component.kind && resource.name === component.name,
        );
        component.precedence = {
          shadowedBy: winningComponent?.id ?? winner.plugin.id,
        };
      }
    }
  }

  return rows.flatMap((row) => [row.plugin, ...row.components]);
}

function claudePluginScopeRank(scope: ResourceScope): number {
  if (scope === "managed") {
    return 400;
  }
  if (scope === "local") {
    return 300;
  }
  if (scope === "project") {
    return 200;
  }
  return 100;
}

async function discoverMcpServers(
  context: ScanContext,
  providerVersion: string,
  roots: ReadonlyArray<readonly [string, string]>,
): Promise<ResourceRecord[]> {
  const sources: Array<{
    filePath: string;
    scope: ResourceScope;
    servers: Record<string, unknown>;
    rank: number;
  }> = [];
  const userConfigPath = path.join(context.homeDirectory, ".claude.json");
  const userConfig = await readJsonFile(userConfigPath);
  if (isRecord(userConfig)) {
    if (isRecord(userConfig.mcpServers)) {
      sources.push({
        filePath: userConfigPath,
        scope: "user",
        servers: userConfig.mcpServers,
        rank: 200,
      });
    }
    const projects: Record<string, unknown> = isRecord(userConfig.projects)
      ? userConfig.projects
      : {};
    const project = projects[context.repositoryPath];
    if (isRecord(project) && isRecord(project.mcpServers)) {
      sources.push({
        filePath: userConfigPath,
        scope: "local",
        servers: project.mcpServers,
        rank: 400,
      });
    }
  }
  const projectConfigPath = path.join(context.repositoryPath, ".mcp.json");
  const projectConfig = await readJsonFile(projectConfigPath);
  if (isRecord(projectConfig) && isRecord(projectConfig.mcpServers)) {
    sources.push({
      filePath: projectConfigPath,
      scope: "project",
      servers: projectConfig.mcpServers,
      rank: 300,
    });
  }

  const discovered: Array<{ resource: ResourceRecord; rank: number; eligible: boolean }> = [];
  for (const source of sources) {
    const shownPath = displayPath(source.filePath, context, roots);
    for (const [name, rawServer] of Object.entries(source.servers)) {
      if (!isRecord(rawServer)) {
        continue;
      }
      discovered.push({
        rank: source.rank,
        eligible: true,
        resource: {
          id: resourceId("claude", "mcp", `${source.scope}:${name}:${shownPath}`),
          kind: "mcp",
          provider: "claude",
          providerVersion,
          name,
          scope: source.scope,
          origin: "claude-mcp-config",
          owner: { type: "self" },
          path: await canonicalPath(source.filePath),
          displayPath: shownPath,
          state: "active",
          precedence: {},
          evidenceType: "parsed",
          evidenceReceipt: `file:${shownPath}`,
          capabilities: ["inspect"],
          metadata: sanitizeTransport(rawServer),
          findings: [],
        },
      });
    }
  }
  resolveNamedPrecedence(discovered);

  return discovered.map(({ resource }) => resource);
}

function resolveNamedPrecedence(
  records: Array<{ resource: ResourceRecord; rank: number; eligible: boolean }>,
): void {
  const names = new Set(records.map(({ resource }) => resource.name));
  for (const name of names) {
    const candidates = records
      .filter(
        (record) =>
          record.resource.name === name &&
          record.eligible &&
          record.resource.state !== "invalid",
      )
      .sort((left, right) => right.rank - left.rank);
    const winner = candidates[0]?.resource;
    if (!winner) {
      continue;
    }
    winner.state = "active";
    winner.precedence = { priority: candidates[0]?.rank ?? 0 };
    for (const candidate of candidates.slice(1)) {
      candidate.resource.state = "shadowed";
      candidate.resource.precedence = { shadowedBy: winner.id };
    }
  }
}

function claudeScope(value: unknown): ResourceScope {
  return value === "managed" || value === "project" || value === "local"
    ? value
    : "user";
}

function instructionRank(resource: ResourceRecord): number {
  if (resource.name === "CLAUDE.local.md") {
    return 2;
  }
  return resource.displayPath?.includes("/.claude/CLAUDE.md") ? 1 : 0;
}

function compareResources(left: ResourceRecord, right: ResourceRecord): number {
  return `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
    `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
  );
}
