import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

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
} from "../core/schema.ts";

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities: AdapterCapabilities = {
    resourceKinds: ["instruction", "skill", "plugin", "mcp"],
    nativeInspection: true,
  };

  async detect(context: ScanContext): Promise<ProviderDetection> {
    const codexHome = path.resolve(
      context.environment.CODEX_HOME ??
        path.join(context.homeDirectory, ".codex"),
    );
    const executablePath = context.executables?.codex ?? "codex";
    const result = spawnSync(executablePath, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, ...context.environment },
      timeout: 2_000,
    });
    const version = parseVersion(result.stdout);
    const installed = result.status === 0;
    const configRoots = [codexHome];
    const projectConfigRoot = path.join(context.repositoryPath, ".codex");

    if (await isDirectory(projectConfigRoot)) {
      configRoots.push(projectConfigRoot);
    }

    return {
      provider: this.provider,
      installed,
      version,
      support: !installed
        ? "unavailable"
        : isSupportedCodexVersion(version)
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
    const codexHome = detection.configRoots[0] ?? path.join(context.homeDirectory, ".codex");
    const userConfigPath = path.join(codexHome, "config.toml");
    const projectConfigPath = path.join(context.repositoryPath, ".codex", "config.toml");
    const userConfig = await loadConfig(userConfigPath);
    const projectConfig = await loadConfig(projectConfigPath);
    const fallbackNames = getFallbackNames(userConfig);
    const projectNames = [
      "AGENTS.override.md",
      "AGENTS.md",
      ...fallbackNames,
    ];
    const discoveredPaths = [
      ...(await existingFiles(codexHome, ["AGENTS.override.md", "AGENTS.md"])),
      ...(await findNamedFiles(context.repositoryPath, new Set(projectNames))),
    ];

    const instructionResources = await Promise.all(
      discoveredPaths.map((discoveredPath) =>
        createInstructionResource(
          discoveredPath,
          context,
          codexHome,
          detection.version,
        ),
      ),
    );
    const standaloneSkills = await discoverStandaloneSkills(
      context,
      codexHome,
      detection.version,
    );
    const pluginResources = await discoverPlugins(
      context,
      detection,
      codexHome,
    );
    const nativeMcpResources = await discoverNativeMcpServers(
      context,
      detection,
      codexHome,
      pluginResources,
      userConfig,
      projectConfig,
      userConfigPath,
      projectConfigPath,
    );
    const resources = [
      ...instructionResources,
      ...standaloneSkills,
      ...pluginResources,
      ...nativeMcpResources,
    ];

    return resources.sort((left, right) =>
      `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
        `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
      ),
    );
  }

  async resolveEffective(
    context: ScanContext,
    resources: ResourceRecord[],
    detection: ProviderDetection,
  ): Promise<EffectiveConfiguration> {
    const codexHome = path.resolve(
      context.environment.CODEX_HOME ??
        path.join(context.homeDirectory, ".codex"),
    );
    const fallbackNames = getFallbackNames(
      await loadConfig(path.join(codexHome, "config.toml")),
    );
    const projectNames = [
      "AGENTS.override.md",
      "AGENTS.md",
      ...fallbackNames,
    ];
    const resolvedResources: ResourceRecord[] = resources.map((resource) =>
      resource.kind === "instruction"
        ? { ...resource, state: "inactive", precedence: {} }
        : { ...resource, precedence: { ...resource.precedence } },
    );
    const orderedResourceIds: string[] = [];
    let chainOrder = 0;

    const globalResources = resolvedResources.filter(
      (resource) =>
        resource.kind === "instruction" &&
        resource.scope === "user" &&
        resource.metadata.empty !== true,
    );
    const globalSelection = selectByName(globalResources, [
      "AGENTS.override.md",
      "AGENTS.md",
    ]);

    if (globalSelection) {
      activate(globalSelection, chainOrder, "global");
      orderedResourceIds.push(globalSelection.id);
      chainOrder += 1;
      shadowSiblings(globalResources, globalSelection);
    }

    const chainDirectories = directoriesFromRoot(
      context.repositoryPath,
      context.workingDirectory,
    );

    for (const [directoryDepth, directory] of chainDirectories.entries()) {
      const candidates = resolvedResources.filter(
        (resource) =>
          resource.kind === "instruction" &&
          resource.scope === "project" &&
          resource.metadata.discoveredDirectory === directory &&
          resource.metadata.empty !== true,
      );
      const selection = selectByName(candidates, projectNames);

      if (!selection) {
        continue;
      }

      activate(selection, chainOrder, "project", directoryDepth);
      orderedResourceIds.push(selection.id);
      chainOrder += 1;
      shadowSiblings(candidates, selection);
    }

    const decisions = resolvedResources.map((resource) => ({
      resourceId: resource.id,
      state: resource.state,
      ...(typeof resource.precedence.chainOrder === "number"
        ? { order: resource.precedence.chainOrder }
        : {}),
      reason: this.explain(resource),
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      provider: this.provider,
      providerVersion: detection.version,
      repositoryPath: context.repositoryPath,
      workingDirectory: context.workingDirectory,
      orderedResourceIds,
      resources: resolvedResources,
      decisions,
    };
  }

  async validate(
    _context: ScanContext,
    resources: ResourceRecord[],
  ): Promise<Finding[]> {
    return resources.flatMap((resource) => resource.findings);
  }

  explain(resource: ResourceRecord): string {
    if (resource.state === "invalid") {
      return "The resource failed deterministic validation.";
    }
    if (resource.state === "disabled") {
      return "The resource is installed but disabled in the effective Codex configuration.";
    }
    if (resource.state === "active") {
      return resource.kind === "instruction"
        ? "Selected for the Codex instruction chain at this scope."
        : "Available in the effective Codex configuration.";
    }
    if (resource.state === "shadowed") {
      return resource.precedence.duplicateOf
        ? "This compatibility path resolves to a resource already counted as active."
        : "A higher-precedence instruction file in the same directory was selected.";
    }
    return "Discovered, but outside the effective configuration for this working directory.";
  }
}

function parseVersion(output: unknown): string {
  return typeof output === "string"
    ? output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? "unknown"
    : "unknown";
}

function isSupportedCodexVersion(version: string): boolean {
  const match = version.match(/^0\.(\d+)\./);
  if (!match?.[1]) {
    return false;
  }
  const minor = Number(match[1]);
  return minor >= 117 && minor <= 154;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function loadConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    return parseToml(await readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

function getFallbackNames(config: Record<string, unknown>): string[] {
  const configured = config.project_doc_fallback_filenames;

  if (!Array.isArray(configured)) {
    return [];
  }

  return configured.filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
}

async function existingFiles(
  directory: string,
  names: string[],
): Promise<string[]> {
  const files: string[] = [];

  for (const name of names) {
    const candidate = path.join(directory, name);
    try {
      if ((await stat(candidate)).isFile()) {
        files.push(candidate);
      }
    } catch {
      continue;
    }
  }

  return files;
}

async function findNamedFiles(
  directory: string,
  names: ReadonlySet<string>,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findNamedFiles(candidate, names)));
    } else if ((entry.isFile() || entry.isSymbolicLink()) && names.has(entry.name)) {
      files.push(candidate);
    }
  }

  return files;
}

async function createInstructionResource(
  discoveredPath: string,
  context: ScanContext,
  codexHome: string,
  providerVersion: string,
): Promise<ResourceRecord> {
  const canonicalPath = await realpath(discoveredPath);
  const contents = await readFile(discoveredPath);
  const inCodexHome = isWithin(codexHome, discoveredPath);
  const displayPath = inCodexHome
    ? displayRelative("$CODEX_HOME", codexHome, discoveredPath)
    : displayRelative("$REPO", context.repositoryPath, discoveredPath);

  return {
    id: resourceId("instruction", displayPath),
    kind: "instruction",
    provider: "codex",
    providerVersion,
    name: path.basename(discoveredPath),
    scope: inCodexHome ? "user" : "project",
    origin: inCodexHome ? "codex-home" : "repository",
    owner: { type: "self" },
    path: canonicalPath,
    displayPath,
    state: "inactive",
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${displayPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      byteLength: contents.byteLength,
      discoveredDirectory: path.dirname(discoveredPath),
      discoveredPath,
      empty: contents.toString("utf8").trim().length === 0,
    },
    findings: [],
  };
}

async function discoverStandaloneSkills(
  context: ScanContext,
  codexHome: string,
  providerVersion: string,
): Promise<ResourceRecord[]> {
  const skillLocations: Array<{
    skillPath: string;
    scope: "user" | "project" | "managed";
    origin: string;
    active: boolean;
  }> = [];
  const userSkillRoot = path.join(context.homeDirectory, ".agents", "skills");
  const compatibilitySkillRoot = path.join(codexHome, "skills");

  for (const skillPath of await findSkillFiles(userSkillRoot)) {
    skillLocations.push({
      skillPath,
      scope: "user",
      origin: "agents-user",
      active: true,
    });
  }

  for (const skillPath of await findSkillFiles(compatibilitySkillRoot)) {
    skillLocations.push({
      skillPath,
      scope: "user",
      origin: "codex-home-compatibility",
      active: true,
    });
  }

  const chainDirectories = new Set(
    directoriesFromRoot(context.repositoryPath, context.workingDirectory),
  );
  for (const skillPath of await findNamedFiles(
    context.repositoryPath,
    new Set(["SKILL.md"]),
  )) {
    const scopeDirectory = repositorySkillScopeDirectory(skillPath);
    if (!scopeDirectory) {
      continue;
    }
    skillLocations.push({
      skillPath,
      scope: "project",
      origin: "agents-repository",
      active: chainDirectories.has(scopeDirectory),
    });
  }

  const adminRoot = context.adminRoots?.codex ?? "/etc/codex";
  for (const skillPath of await findSkillFiles(path.join(adminRoot, "skills"))) {
    skillLocations.push({
      skillPath,
      scope: "managed",
      origin: "codex-admin",
      active: true,
    });
  }

  const skills = await Promise.all(
    skillLocations.map(({ skillPath, scope, origin, active }) =>
      createSkillResource({
        skillPath,
        context,
        codexHome,
        providerVersion,
        scope,
        origin,
        owner: { type: "self" },
        state: active ? "active" : "inactive",
      }),
    ),
  );

  markCanonicalDuplicates(skills);
  return skills;
}

async function findSkillFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const skillFiles: string[] = [];

    for (const entry of entries) {
      const skillDirectory = path.join(root, entry.name);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      try {
        if ((await stat(skillDirectory)).isDirectory()) {
          const skillFile = path.join(skillDirectory, "SKILL.md");
          if ((await stat(skillFile)).isFile()) {
            skillFiles.push(skillFile);
          }
        }
      } catch {
        continue;
      }
    }

    return skillFiles.sort();
  } catch {
    return [];
  }
}

function repositorySkillScopeDirectory(skillPath: string): string | undefined {
  const segments = path.resolve(skillPath).split(path.sep);
  for (let index = segments.length - 3; index >= 0; index -= 1) {
    if (segments[index] === ".agents" && segments[index + 1] === "skills") {
      return segments.slice(0, index).join(path.sep) || path.sep;
    }
  }
  return undefined;
}

interface CreateSkillResourceOptions {
  skillPath: string;
  context: ScanContext;
  codexHome: string;
  providerVersion: string;
  scope: "user" | "project" | "managed" | "bundled";
  origin: string;
  owner: ResourceRecord["owner"];
  state: ResourceRecord["state"];
}

async function createSkillResource({
  skillPath,
  context,
  codexHome,
  providerVersion,
  scope,
  origin,
  owner,
  state,
}: CreateSkillResourceOptions): Promise<ResourceRecord> {
  const canonicalPath = await realpath(skillPath);
  const contents = await readFile(skillPath, "utf8");
  const directoryName = path.basename(path.dirname(skillPath));
  const frontmatter = parseSkillFrontmatter(contents);
  const displayPath = displayKnownPath(skillPath, context, codexHome);
  const id = resourceId("skill", displayPath);
  const findings: Finding[] = [];

  if (frontmatter.error) {
    findings.push({
      code: "codex.skill.invalid-frontmatter",
      severity: "error",
      confidence: "high",
      message: frontmatter.error,
      resourceId: id,
    });
  }
  if (frontmatter.name && frontmatter.name !== directoryName) {
    findings.push({
      code: "codex.skill.name-directory-mismatch",
      severity: "error",
      confidence: "high",
      message: `Skill name ${frontmatter.name} does not match directory ${directoryName}.`,
      resourceId: id,
    });
  }

  const invalid = findings.some((finding) => finding.severity === "error");
  return {
    id,
    kind: "skill",
    provider: "codex",
    providerVersion,
    name: frontmatter.name ?? directoryName,
    scope,
    origin,
    owner,
    path: canonicalPath,
    displayPath,
    state: invalid ? "invalid" : state,
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${displayPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      canonicalTarget: canonicalPath,
      description: frontmatter.description ?? "",
      directoryName,
    },
    findings,
  };
}

function parseSkillFrontmatter(contents: string): {
  name?: string;
  description?: string;
  error?: string;
} {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    return { error: "SKILL.md must begin with YAML frontmatter." };
  }

  try {
    const parsed = parseYaml(match[1]);
    if (!isRecord(parsed)) {
      return { error: "SKILL.md frontmatter must be a YAML object." };
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const description =
      typeof parsed.description === "string" ? parsed.description.trim() : "";

    if (!name || !description) {
      return { error: "SKILL.md frontmatter requires name and description." };
    }
    return { name, description };
  } catch {
    return { error: "SKILL.md frontmatter is not valid YAML." };
  }
}

function markCanonicalDuplicates(skills: ResourceRecord[]): void {
  const byTarget = new Map<string, ResourceRecord[]>();

  for (const skill of skills) {
    if (!skill.path) {
      continue;
    }
    const group = byTarget.get(skill.path) ?? [];
    group.push(skill);
    byTarget.set(skill.path, group);
  }

  for (const group of byTarget.values()) {
    if (group.length < 2) {
      continue;
    }
    group.sort((left, right) => compatibilityRank(left) - compatibilityRank(right));
    const selected = group[0];
    if (!selected) {
      continue;
    }
    for (const duplicate of group.slice(1)) {
      if (duplicate.state === "invalid") {
        continue;
      }
      duplicate.state = "shadowed";
      duplicate.precedence = { duplicateOf: selected.id };
    }
  }
}

function compatibilityRank(resource: ResourceRecord): number {
  return resource.origin.includes("compatibility") ? 1 : 0;
}

async function discoverPlugins(
  context: ScanContext,
  detection: ProviderDetection,
  codexHome: string,
): Promise<ResourceRecord[]> {
  const payload = runCodexJson(
    detection.executablePath,
    ["-C", context.workingDirectory, "plugin", "list", "--json"],
    context,
  );
  if (!isRecord(payload) || !Array.isArray(payload.installed)) {
    return [];
  }

  const resources: ResourceRecord[] = [];
  for (const rawPlugin of payload.installed) {
    if (!isRecord(rawPlugin)) {
      continue;
    }
    const name = stringValue(rawPlugin.name);
    const pluginId = stringValue(rawPlugin.pluginId);
    if (!name || !pluginId) {
      continue;
    }

    const source = isRecord(rawPlugin.source) ? rawPlugin.source : {};
    const rawPluginPath = stringValue(source.path);
    const pluginPath = rawPluginPath
      ? await realpathIfAvailable(rawPluginPath)
      : undefined;
    const displayPath = rawPluginPath
      ? displayKnownPath(rawPluginPath, context, codexHome)
      : undefined;
    const enabled = rawPlugin.enabled !== false;
    const version = stringValue(rawPlugin.version) ?? "unknown";
    const marketplaceName = stringValue(rawPlugin.marketplaceName) ?? "unknown";
    const plugin: ResourceRecord = {
      id: resourceId("plugin", pluginId),
      kind: "plugin",
      provider: "codex",
      providerVersion: detection.version,
      name,
      scope: "user",
      origin: `marketplace:${marketplaceName}`,
      owner: { type: "self" },
      ...(pluginPath ? { path: pluginPath } : {}),
      ...(displayPath ? { displayPath } : {}),
      state: enabled ? "active" : "disabled",
      precedence: {},
      evidenceType: "native",
      evidenceReceipt: "command:codex plugin list --json",
      capabilities: ["inspect"],
      metadata: {
        enabled,
        installed: rawPlugin.installed === true,
        marketplaceName,
        version,
        ...(stringValue(source.source)
          ? { sourceType: stringValue(source.source) as string }
          : {}),
      },
      findings: [],
    };
    resources.push(plugin);

    if (pluginPath) {
      resources.push(
        ...(await discoverPluginChildren(
          plugin,
          pluginId,
          pluginPath,
          context,
          codexHome,
          detection.version,
        )),
      );
    }
  }

  return resources;
}

async function discoverPluginChildren(
  plugin: ResourceRecord,
  pluginId: string,
  pluginPath: string,
  context: ScanContext,
  codexHome: string,
  providerVersion: string,
): Promise<ResourceRecord[]> {
  const resources: ResourceRecord[] = [];
  const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
  const manifest = await loadJsonFile(manifestPath);
  const skillRootValue = isRecord(manifest)
    ? stringValue(manifest.skills)
    : undefined;

  if (skillRootValue) {
    const skillRoot = path.resolve(pluginPath, skillRootValue);
    for (const skillPath of await findSkillFiles(skillRoot)) {
      resources.push(
        await createSkillResource({
          skillPath,
          context,
          codexHome,
          providerVersion,
          scope: "bundled",
          origin: "plugin",
          owner: { type: "plugin", id: pluginId },
          state: plugin.state === "active" ? "active" : "disabled",
        }),
      );
    }
  }

  const mcpConfigPath = path.join(pluginPath, ".mcp.json");
  const mcpConfig = await loadJsonFile(mcpConfigPath);
  const mcpServers = isRecord(mcpConfig) && isRecord(mcpConfig.mcpServers)
    ? mcpConfig.mcpServers
    : {};
  for (const [name, rawServer] of Object.entries(mcpServers)) {
    if (!isRecord(rawServer)) {
      continue;
    }
    const displayPath = displayKnownPath(mcpConfigPath, context, codexHome);
    resources.push({
      id: resourceId("mcp", `${pluginId}:${name}`),
      kind: "mcp",
      provider: "codex",
      providerVersion,
      name,
      scope: "bundled",
      origin: "plugin",
      owner: { type: "plugin", id: pluginId },
      path: await realpathIfAvailable(mcpConfigPath),
      displayPath,
      state: plugin.state === "active" ? "active" : "disabled",
      precedence: {},
      evidenceType: "parsed",
      evidenceReceipt: `file:${displayPath}`,
      capabilities: ["inspect"],
      metadata: sanitizeMcpTransport(rawServer),
      findings: [],
    });
  }

  return resources;
}

async function discoverNativeMcpServers(
  context: ScanContext,
  detection: ProviderDetection,
  codexHome: string,
  pluginResources: ResourceRecord[],
  userConfig: Record<string, unknown>,
  projectConfig: Record<string, unknown>,
  userConfigPath: string,
  projectConfigPath: string,
): Promise<ResourceRecord[]> {
  const payload = runCodexJson(
    detection.executablePath,
    ["-C", context.workingDirectory, "mcp", "list", "--json"],
    context,
  );
  if (!Array.isArray(payload)) {
    return [];
  }

  const resources: ResourceRecord[] = [];
  for (const rawServer of payload) {
    if (!isRecord(rawServer)) {
      continue;
    }
    const name = stringValue(rawServer.name);
    const transport = isRecord(rawServer.transport) ? rawServer.transport : undefined;
    if (!name || !transport) {
      continue;
    }
    const projectScoped = configHasMcpServer(projectConfig, name);
    const userScoped = configHasMcpServer(userConfig, name);
    const pluginMatches = pluginResources.filter(
      (resource) =>
        resource.kind === "mcp" &&
        resource.name === name &&
        resource.owner.type === "plugin",
    );

    if (!projectScoped && !userScoped && pluginMatches.length === 1) {
      const pluginMcp = pluginMatches[0];
      if (pluginMcp) {
        pluginMcp.state = rawServer.enabled === false ? "disabled" : "active";
        pluginMcp.metadata = {
          ...pluginMcp.metadata,
          nativeInspection: true,
          nativeEvidenceReceipt: "command:codex mcp list --json",
          nativeTransport: sanitizeMcpTransport(transport),
          ...(stringValue(rawServer.auth_status)
            ? { nativeAuthStatus: stringValue(rawServer.auth_status) as string }
            : {}),
          nativeHasDisabledReason: rawServer.disabled_reason != null,
        };
      }
      continue;
    }

    const sourcePath = projectScoped ? projectConfigPath : userConfigPath;
    const displayPath = displayKnownPath(sourcePath, context, codexHome);

    resources.push({
      id: resourceId("mcp", `standalone:${name}`),
      kind: "mcp",
      provider: "codex",
      providerVersion: detection.version,
      name,
      scope: projectScoped ? "project" : "user",
      origin: "codex-config",
      owner: { type: "self" },
      path: await realpathIfAvailable(sourcePath),
      displayPath,
      state: rawServer.enabled === false ? "disabled" : "active",
      precedence: {},
      evidenceType: "native",
      evidenceReceipt: "command:codex mcp list --json",
      capabilities: ["inspect"],
      metadata: {
        ...sanitizeMcpTransport(transport),
        ...(stringValue(rawServer.auth_status)
          ? { authStatus: stringValue(rawServer.auth_status) as string }
          : {}),
        hasDisabledReason: rawServer.disabled_reason != null,
      },
      findings: [],
    });
  }

  return resources;
}

function runCodexJson(
  executablePath: string | undefined,
  args: string[],
  context: ScanContext,
): unknown {
  if (!executablePath) {
    return undefined;
  }
  const result = spawnSync(executablePath, args, {
    cwd: context.workingDirectory,
    encoding: "utf8",
    env: { ...process.env, ...context.environment },
    timeout: 5_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function sanitizeMcpTransport(transport: Record<string, unknown>): Record<string, import("../core/schema.ts").JsonValue> {
  const transportType = stringValue(transport.type) ??
    (typeof transport.command === "string" ? "stdio" : "streamable_http");
  const metadata: Record<string, import("../core/schema.ts").JsonValue> = {
    transportType,
  };

  if (transportType === "stdio") {
    const env = isRecord(transport.env) ? transport.env : {};
    metadata.command = stringValue(transport.command) ?? "unknown";
    metadata.argumentCount = Array.isArray(transport.args) ? transport.args.length : 0;
    metadata.environmentVariableNames = Object.keys(env).sort();
    metadata.forwardedEnvironmentVariableNames = Array.isArray(transport.env_vars)
      ? transport.env_vars.filter((value): value is string => typeof value === "string").sort()
      : [];
    metadata.hasWorkingDirectory = typeof transport.cwd === "string";
    return metadata;
  }

  const staticHeaders = isRecord(transport.http_headers)
    ? transport.http_headers
    : {};
  const environmentHeaders = isRecord(transport.env_http_headers)
    ? transport.env_http_headers
    : {};
  metadata.url = redactUrl(stringValue(transport.url));
  metadata.staticHeaderNames = Object.keys(staticHeaders).sort();
  metadata.environmentHeaderNames = Object.keys(environmentHeaders).sort();
  metadata.hasHeaderHelper = typeof transport.http_headers_helper === "string";
  if (typeof transport.bearer_token_env_var === "string") {
    metadata.bearerTokenEnvironmentVariable = transport.bearer_token_env_var;
  }
  return metadata;
}

function redactUrl(rawUrl: string | undefined): string {
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

function configHasMcpServer(
  config: Record<string, unknown>,
  name: string,
): boolean {
  return isRecord(config.mcp_servers) && name in config.mcp_servers;
}

async function loadJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function realpathIfAvailable(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function displayKnownPath(
  candidate: string,
  context: ScanContext,
  codexHome: string,
): string {
  if (isWithin(codexHome, candidate)) {
    return displayRelative("$CODEX_HOME", codexHome, candidate);
  }
  if (isWithin(context.repositoryPath, candidate)) {
    return displayRelative("$REPO", context.repositoryPath, candidate);
  }
  if (isWithin(context.homeDirectory, candidate)) {
    return displayRelative("$HOME", context.homeDirectory, candidate);
  }
  return `<external>/${path.basename(candidate)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resourceId(kind: ResourceRecord["kind"], identity: string): string {
  return createHash("sha256")
    .update(`codex\0${kind}\0${identity}`)
    .digest("hex")
    .slice(0, 20);
}

function displayRelative(label: string, root: string, candidate: string): string {
  const relativePath = path.relative(root, candidate).split(path.sep).join("/");
  return relativePath ? `${label}/${relativePath}` : label;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`))
  );
}

function directoriesFromRoot(root: string, workingDirectory: string): string[] {
  const resolvedRoot = path.resolve(root);
  const resolvedWorkingDirectory = path.resolve(workingDirectory);

  if (!isWithin(resolvedRoot, resolvedWorkingDirectory)) {
    return [];
  }

  const relativeDirectory = path.relative(resolvedRoot, resolvedWorkingDirectory);
  const segments = relativeDirectory ? relativeDirectory.split(path.sep) : [];
  return [
    resolvedRoot,
    ...segments.map((_, index) =>
      path.join(resolvedRoot, ...segments.slice(0, index + 1)),
    ),
  ];
}

function selectByName(
  resources: ResourceRecord[],
  names: string[],
): ResourceRecord | undefined {
  for (const name of names) {
    const resource = resources.find((candidate) => candidate.name === name);
    if (resource) {
      return resource;
    }
  }
  return undefined;
}

function activate(
  resource: ResourceRecord,
  chainOrder: number,
  instructionScope: "global" | "project",
  directoryDepth?: number,
): void {
  resource.state = "active";
  resource.precedence = {
    chainOrder,
    instructionScope,
    ...(directoryDepth === undefined ? {} : { directoryDepth }),
  };
}

function shadowSiblings(
  resources: ResourceRecord[],
  selected: ResourceRecord,
): void {
  for (const resource of resources) {
    if (resource.id === selected.id) {
      continue;
    }
    resource.state = "shadowed";
    resource.precedence = { shadowedBy: selected.id };
  }
}
