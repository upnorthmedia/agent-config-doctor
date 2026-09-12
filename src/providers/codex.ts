import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

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
  JsonValue,
  ResourceRecord,
} from "../core/schema.ts";
import {
  canonicalPath,
  directoriesFromRoot,
  displayPath,
  findNamedFiles,
  isDirectory,
  isRecord,
  isWithin,
  parseSemanticVersion,
  parseSkillFrontmatter,
  reachForDirectory,
  readJsonFile,
  resourceId,
  runCommand,
  runJsonCommand,
  sanitizeUrl,
  stringValue,
} from "./shared.ts";

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities: AdapterCapabilities = {
    resourceKinds: ["instruction", "skill", "plugin", "mcp"],
    nativeInspection: true,
  };

  async detect(context: ScanContext): Promise<ProviderDetection> {
    const codexHome = codexHomeFor(context);
    const executablePath = context.executables?.codex ?? "codex";
    const result = runCommand(executablePath, ["--version"], context, 2_000);
    const version = parseSemanticVersion(result.stdout);
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
    const codexHome = detection.configRoots[0] ?? codexHomeFor(context);
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

    return resources.sort(compareResources);
  }

  async resolveEffective(
    context: ScanContext,
    resources: ResourceRecord[],
    detection: ProviderDetection,
  ): Promise<EffectiveConfiguration> {
    const codexHome = codexHomeFor(context);
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

function codexHomeFor(context: ScanContext): string {
  return path.resolve(
    context.environment.CODEX_HOME ?? path.join(context.homeDirectory, ".codex"),
  );
}

function isSupportedCodexVersion(version: string): boolean {
  const match = version.match(/^0\.(\d+)\./);
  if (!match?.[1]) {
    return false;
  }
  const minor = Number(match[1]);
  return minor >= 117 && minor <= 154;
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

function displayKnownPath(
  candidate: string,
  context: ScanContext,
  codexHome: string,
): string {
  return displayPath(candidate, context, [["$CODEX_HOME", codexHome]]);
}

async function createInstructionResource(
  discoveredPath: string,
  context: ScanContext,
  codexHome: string,
  providerVersion: string,
): Promise<ResourceRecord> {
  const canonical = await canonicalPath(discoveredPath);
  const contents = await readFile(discoveredPath);
  const inCodexHome = isWithin(codexHome, discoveredPath);
  const shownPath = displayKnownPath(discoveredPath, context, codexHome);
  const discoveredDirectory = path.dirname(discoveredPath);

  return {
    id: resourceId("codex", "instruction", shownPath),
    kind: "instruction",
    provider: "codex",
    providerVersion,
    name: path.basename(discoveredPath),
    scope: inCodexHome ? "user" : "project",
    origin: inCodexHome ? "codex-home" : "repository",
    owner: { type: "self" },
    path: canonical,
    displayPath: shownPath,
    reach: inCodexHome ? "chain" : reachForDirectory(discoveredDirectory, context),
    state: "inactive",
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${shownPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      byteLength: contents.byteLength,
      discoveredDirectory,
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
    scope: CreateSkillResourceOptions["scope"];
    origin: string;
    owner: ResourceRecord["owner"];
    reach: ResourceRecord["reach"];
    active: boolean;
  }> = [];
  const userSkillRoot = path.join(context.homeDirectory, ".agents", "skills");
  const compatibilitySkillRoot = path.join(codexHome, "skills");
  const systemSkillRoot = path.join(compatibilitySkillRoot, ".system");

  for (const skillPath of await skillFilesInRoot(userSkillRoot)) {
    skillLocations.push({
      skillPath,
      scope: "user",
      origin: "agents-user",
      owner: { type: "self" },
      reach: "chain",
      active: true,
    });
  }

  for (const skillPath of await skillFilesInRoot(compatibilitySkillRoot)) {
    skillLocations.push({
      skillPath,
      scope: "user",
      origin: "codex-home-compatibility",
      owner: { type: "self" },
      reach: "chain",
      active: true,
    });
  }

  // Codex installs its own skills under skills/.system. They are runtime copies
  // that Codex controls, so they are provider-owned rather than user errors.
  for (const skillPath of await skillFilesInRoot(systemSkillRoot)) {
    skillLocations.push({
      skillPath,
      scope: "bundled",
      origin: "codex-system",
      owner: { type: "provider", id: "codex" },
      reach: "chain",
      active: true,
    });
  }

  for (const skillPath of await findNamedFiles(
    context.repositoryPath,
    new Set(["SKILL.md"]),
  )) {
    const scopeDirectory = repositorySkillScopeDirectory(skillPath);
    if (!scopeDirectory) {
      continue;
    }
    const reach = reachForDirectory(scopeDirectory, context);
    skillLocations.push({
      skillPath,
      scope: "project",
      origin: "agents-repository",
      owner: { type: "self" },
      reach,
      active: reach === "chain",
    });
  }

  const adminRoot = context.adminRoots?.codex ?? "/etc/codex";
  for (const skillPath of await skillFilesInRoot(path.join(adminRoot, "skills"))) {
    skillLocations.push({
      skillPath,
      scope: "managed",
      origin: "codex-admin",
      owner: { type: "administrator" },
      reach: "chain",
      active: true,
    });
  }

  const skills = await Promise.all(
    skillLocations.map(({ skillPath, scope, origin, owner, reach, active }) =>
      createSkillResource({
        skillPath,
        context,
        codexHome,
        providerVersion,
        scope,
        origin,
        owner,
        reach,
        state: active ? "active" : "inactive",
      }),
    ),
  );

  markCanonicalDuplicates(skills);
  return skills;
}

/**
 * Codex skill roots hold one directory per skill. Symlinked skill directories
 * are followed here because Codex follows them too.
 */
async function skillFilesInRoot(root: string): Promise<string[]> {
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
  reach: ResourceRecord["reach"];
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
  reach,
  state,
}: CreateSkillResourceOptions): Promise<ResourceRecord> {
  const canonical = await canonicalPath(skillPath);
  const contents = await readFile(skillPath, "utf8");
  const directoryName = path.basename(path.dirname(skillPath));
  const frontmatter = parseSkillFrontmatter(contents);
  const shownPath = displayKnownPath(skillPath, context, codexHome);
  const id = resourceId("codex", "skill", shownPath);
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
    path: canonical,
    displayPath: shownPath,
    ...(reach ? { reach } : {}),
    state: invalid ? "invalid" : state,
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${shownPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      canonicalTarget: canonical,
      description: frontmatter.description ?? "",
      directoryName,
    },
    findings,
  };
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
  const payload = runJsonCommand(
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
      ? await canonicalPath(rawPluginPath)
      : undefined;
    const shownPath = rawPluginPath
      ? displayKnownPath(rawPluginPath, context, codexHome)
      : undefined;
    const enabled = rawPlugin.enabled !== false;
    const version = stringValue(rawPlugin.version) ?? "unknown";
    const marketplaceName = stringValue(rawPlugin.marketplaceName) ?? "unknown";
    const plugin: ResourceRecord = {
      id: resourceId("codex", "plugin", pluginId),
      kind: "plugin",
      provider: "codex",
      providerVersion: detection.version,
      name,
      scope: "user",
      origin: `marketplace:${marketplaceName}`,
      owner: { type: "self" },
      ...(pluginPath ? { path: pluginPath } : {}),
      ...(shownPath ? { displayPath: shownPath } : {}),
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
  const manifest = await readJsonFile(manifestPath);
  const skillRootValue = isRecord(manifest)
    ? stringValue(manifest.skills)
    : undefined;

  if (skillRootValue) {
    const skillRoot = path.resolve(pluginPath, skillRootValue);
    for (const skillPath of await skillFilesInRoot(skillRoot)) {
      resources.push(
        await createSkillResource({
          skillPath,
          context,
          codexHome,
          providerVersion,
          scope: "bundled",
          origin: "plugin",
          owner: { type: "plugin", id: pluginId },
          reach: "chain",
          state: plugin.state === "active" ? "active" : "disabled",
        }),
      );
    }
  }

  const mcpConfigPath = path.join(pluginPath, ".mcp.json");
  const mcpConfig = await readJsonFile(mcpConfigPath);
  const mcpServers = isRecord(mcpConfig) && isRecord(mcpConfig.mcpServers)
    ? mcpConfig.mcpServers
    : {};
  for (const [name, rawServer] of Object.entries(mcpServers)) {
    if (!isRecord(rawServer)) {
      continue;
    }
    const shownPath = displayKnownPath(mcpConfigPath, context, codexHome);
    resources.push({
      id: resourceId("codex", "mcp", `${pluginId}:${name}`),
      kind: "mcp",
      provider: "codex",
      providerVersion,
      name,
      scope: "bundled",
      origin: "plugin",
      owner: { type: "plugin", id: pluginId },
      path: await canonicalPath(mcpConfigPath),
      displayPath: shownPath,
      state: plugin.state === "active" ? "active" : "disabled",
      precedence: {},
      evidenceType: "parsed",
      evidenceReceipt: `file:${shownPath}`,
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
  const payload = runJsonCommand(
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
    const shownPath = displayKnownPath(sourcePath, context, codexHome);

    resources.push({
      id: resourceId("codex", "mcp", `standalone:${name}`),
      kind: "mcp",
      provider: "codex",
      providerVersion: detection.version,
      name,
      scope: projectScoped ? "project" : "user",
      origin: "codex-config",
      owner: { type: "self" },
      path: await canonicalPath(sourcePath),
      displayPath: shownPath,
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

function sanitizeMcpTransport(transport: Record<string, unknown>): Record<string, JsonValue> {
  const transportType = stringValue(transport.type) ??
    (typeof transport.command === "string" ? "stdio" : "streamable_http");
  const metadata: Record<string, JsonValue> = {
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
  metadata.url = sanitizeUrl(stringValue(transport.url));
  metadata.staticHeaderNames = Object.keys(staticHeaders).sort();
  metadata.environmentHeaderNames = Object.keys(environmentHeaders).sort();
  metadata.hasHeaderHelper = typeof transport.http_headers_helper === "string";
  if (typeof transport.bearer_token_env_var === "string") {
    metadata.bearerTokenEnvironmentVariable = transport.bearer_token_env_var;
  }
  return metadata;
}

function configHasMcpServer(
  config: Record<string, unknown>,
  name: string,
): boolean {
  return isRecord(config.mcp_servers) && name in config.mcp_servers;
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

function compareResources(left: ResourceRecord, right: ResourceRecord): number {
  return `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
    `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
  );
}
