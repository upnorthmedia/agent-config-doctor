import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { SCHEMA_VERSION } from "../core/schema.ts";
import type {
  AdapterCapabilities,
  DiscoveryResult,
  ProviderAdapter,
  ProviderDetection,
  ScanContext,
} from "../core/provider-adapter.ts";
import type {
  EffectiveConfiguration,
  Finding,
  JsonValue,
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
  parseSkillFrontmatter,
  reachForDirectory,
  readJsonFile,
  readYamlFile,
  resourceId,
  runCommand,
  sanitizeTransport,
  stringArray,
  stringValue,
  walkFiles,
} from "./shared.ts";

const CONTEXT_NAMES = new Set([
  ".hermes.md",
  "HERMES.md",
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "claude.md",
  ".cursorrules",
]);

interface SkillCandidate {
  rank: number;
  resource: ResourceRecord;
}

export class HermesAdapter implements ProviderAdapter {
  readonly provider = "hermes" as const;
  readonly capabilities: AdapterCapabilities = {
    resourceKinds: ["instruction", "skill", "plugin", "mcp"],
    nativeInspection: false,
  };

  async detect(context: ScanContext): Promise<ProviderDetection> {
    const executablePath = context.executables?.hermes ?? "hermes";
    const result = await runCommand(executablePath, ["--version"], context, 2_000);
    const version = parseHermesVersion(result.stdout);
    const installed = result.status === 0;
    const hermesHome = getHermesHome(context);
    const configRoots = [hermesHome];
    const projectRoot = path.join(context.repositoryPath, ".hermes");
    if (await isDirectory(projectRoot)) {
      configRoots.push(projectRoot);
    }

    return {
      provider: this.provider,
      installed,
      version,
      support: !installed
        ? "unavailable"
        : isSupportedHermesVersion(version)
          ? "supported"
          : "unsupported",
      executablePath,
      configRoots,
    };
  }

  async discover(
    context: ScanContext,
    detection: ProviderDetection,
  ): Promise<DiscoveryResult> {
    if (detection.support !== "supported") {
      return { resources: [], notices: [] };
    }

    const hermesHome = getHermesHome(context);
    const configPath = path.join(hermesHome, "config.yaml");
    const config = await readYamlFile(configPath);
    const parsedConfig = isRecord(config) ? config : {};
    const plugins = await discoverPlugins(
      context,
      detection.version,
      hermesHome,
      parsedConfig,
    );

    const resources = [
      ...(await discoverInstructions(context, detection.version, hermesHome)),
      ...(await discoverSkills(
        context,
        detection.version,
        hermesHome,
        parsedConfig,
      )),
      ...plugins,
      ...(await discoverPluginSkills(context, detection.version, plugins)),
      ...(await discoverMcpServers(
        context,
        detection.version,
        configPath,
        parsedConfig,
      )),
    ].sort(compareResources);
    return { resources, notices: [] };
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
        resource.kind === "instruction" && resource.state !== "invalid"
          ? ("inactive" as const)
          : resource.state,
    }));
    const orderedResourceIds: string[] = [];
    let order = 0;

    const activate = (resource: ResourceRecord | undefined): void => {
      if (!resource || resource.state === "invalid") {
        return;
      }
      resource.state = "active";
      resource.precedence = { ...resource.precedence, chainOrder: order };
      orderedResourceIds.push(resource.id);
      order += 1;
    };

    activate(
      resolved.find(
        (resource) =>
          resource.kind === "instruction" && resource.origin === "hermes-soul",
      ),
    );

    const instructions = resolved.filter(
      (resource) => resource.kind === "instruction" && resource.scope === "project",
    );
    const chain = directoriesFromRoot(
      context.repositoryPath,
      context.workingDirectory,
    ).reverse();
    const hermesContext = firstContextInChain(instructions, chain, [
      ".hermes.md",
      "HERMES.md",
    ]);

    if (hermesContext) {
      activate(hermesContext);
    } else {
      const currentDirectory = path.resolve(context.workingDirectory);
      const localInstructions = instructions.filter(
        (resource) => resource.metadata.loadDirectory === currentDirectory,
      );
      const standardContext = firstByName(localInstructions, [
        "AGENTS.md",
        "agents.md",
        "CLAUDE.md",
        "claude.md",
      ]);
      if (standardContext) {
        activate(standardContext);
      } else {
        const cursorRules = localInstructions.filter(
          (resource) =>
            resource.name === ".cursorrules" || resource.origin === "cursor-rule",
        );
        for (const resource of cursorRules.sort(compareResources)) {
          activate(resource);
        }
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
    if (resource.state === "invalid") {
      return "The resource failed deterministic validation.";
    }
    if (resource.state === "blocked") {
      return "The resource is blocked by a Hermes trust or policy boundary.";
    }
    if (resource.state === "disabled") {
      return "The resource is installed but explicitly disabled.";
    }
    if (resource.state === "shadowed") {
      return "A higher-precedence resource with the same identity is active.";
    }
    if (resource.state === "active") {
      return resource.kind === "instruction"
        ? "Loaded in the effective Hermes context."
        : "Available in the effective Hermes configuration.";
    }
    return "Installed, but not enabled or selected for this working directory.";
  }
}

function getHermesHome(context: ScanContext): string {
  return path.resolve(
    context.environment.HERMES_HOME ?? path.join(context.homeDirectory, ".hermes"),
  );
}

function parseHermesVersion(output: string): string {
  return output.match(/Hermes Agent v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i)?.[1]
    ?? "unknown";
}

function isSupportedHermesVersion(version: string): boolean {
  return /^0\.12\./.test(version);
}

async function discoverInstructions(
  context: ScanContext,
  providerVersion: string,
  hermesHome: string,
): Promise<ResourceRecord[]> {
  const candidates = [
    path.join(hermesHome, "SOUL.md"),
    ...(await findNamedFiles(context.repositoryPath, CONTEXT_NAMES)),
    ...(await findCursorRules(context.repositoryPath)),
  ];
  const resources: ResourceRecord[] = [];

  for (const candidate of candidates) {
    if (!(await isFile(candidate))) {
      continue;
    }
    const isSoul = path.resolve(candidate) === path.join(hermesHome, "SOUL.md");
    const shownPath = displayPath(candidate, context, [["$HERMES_HOME", hermesHome]]);
    const id = resourceId("hermes", "instruction", shownPath);
    // Cursor rules live in <project>/.cursor/rules, so the project directory
    // that owns them decides whether they sit in the selected chain.
    const ownerDirectory = candidate.endsWith(".mdc")
      ? path.dirname(path.dirname(path.dirname(candidate)))
      : path.dirname(candidate);
    resources.push({
      id,
      kind: "instruction",
      provider: "hermes",
      providerVersion,
      name: path.basename(candidate),
      scope: isSoul ? "user" : "project",
      origin: isSoul
        ? "hermes-soul"
        : candidate.endsWith(".mdc")
          ? "cursor-rule"
          : "hermes-context",
      owner: { type: "self" },
      path: await canonicalPath(candidate),
      displayPath: shownPath,
      reach: isSoul ? "chain" : reachForDirectory(ownerDirectory, context),
      state: "inactive",
      precedence: {},
      evidenceType: "parsed",
      evidenceReceipt: `file:${shownPath}`,
      capabilities: ["inspect", "open"],
      metadata: {
        loadDirectory: path.dirname(candidate),
        contextPriority: contextPriority(path.basename(candidate)),
      },
      findings: [],
    });
  }

  return resources;
}

function findCursorRules(root: string): Promise<string[]> {
  return walkFiles(
    root,
    (name, candidate) =>
      name.endsWith(".mdc") &&
      path.basename(path.dirname(candidate)) === "rules" &&
      path.basename(path.dirname(path.dirname(candidate))) === ".cursor",
  );
}

function contextPriority(name: string): number {
  return [
    ".hermes.md",
    "HERMES.md",
    "AGENTS.md",
    "agents.md",
    "CLAUDE.md",
    "claude.md",
    ".cursorrules",
  ].indexOf(name);
}

function firstContextInChain(
  resources: ResourceRecord[],
  directories: string[],
  names: string[],
): ResourceRecord | undefined {
  for (const directory of directories) {
    const candidates = resources.filter(
      (resource) => resource.metadata.loadDirectory === directory,
    );
    const selected = firstByName(candidates, names);
    if (selected) {
      return selected;
    }
  }
  return undefined;
}

function firstByName(
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

async function discoverSkills(
  context: ScanContext,
  providerVersion: string,
  hermesHome: string,
  config: Record<string, unknown>,
): Promise<ResourceRecord[]> {
  const skillRoot = path.join(hermesHome, "skills");
  const manifest = await readBundledManifest(
    path.join(skillRoot, ".bundled_manifest"),
  );
  const hubEntries = await readHubEntries(path.join(skillRoot, ".hub", "lock.json"));
  const candidates: SkillCandidate[] = [];

  for (const skillPath of await findSkillFiles(skillRoot)) {
    const parsed = parseSkillFrontmatter(await readFile(skillPath, "utf8"));
    const name = parsed.name ?? path.basename(path.dirname(skillPath));
    const hub = hubEntries.get(name);
    const originHash = manifest.get(name);
    const currentHash = originHash === undefined
      ? undefined
      : await directoryHash(path.dirname(skillPath));
    const isProtected = Boolean(originHash && currentHash !== originHash);
    const origin = hub
      ? "hermes-hub"
      : originHash !== undefined
        ? isProtected
          ? "hermes-bundled-protected"
          : "hermes-bundled"
        : "hermes-local";
    const metadata: Record<string, JsonValue> = {
      description: parsed.description ?? "",
      pruningEligible: origin === "hermes-local",
      ...(originHash !== undefined
        ? {
            syncProtection: isProtected
              ? "user-modified"
              : originHash
                ? "upstream-managed"
                : "pending-baseline",
          }
        : {}),
      ...(hub
        ? {
            hubSource: stringValue(hub.source) ?? "unknown",
            trustLevel: stringValue(hub.trust_level) ?? "unknown",
            scanVerdict: stringValue(hub.scan_verdict) ?? "unknown",
          }
        : {}),
    };
    candidates.push({
      rank: 200,
      resource: await createSkillResource({
        context,
        providerVersion,
        skillPath,
        name,
        scope: origin === "hermes-local" ? "user" : "bundled",
        origin,
        state: parsed.error ? "invalid" : "active",
        metadata,
        ...(parsed.error ? { error: parsed.error } : {}),
      }),
    });
  }

  const skillsConfig = isRecord(config.skills) ? config.skills : {};
  const externalDirs = stringArray(skillsConfig.external_dirs)
    .map((candidate) => expandHermesPath(candidate, context))
    .filter((candidate): candidate is string => candidate !== undefined);
  for (const [rootIndex, externalRoot] of externalDirs.entries()) {
    for (const skillPath of await findSkillFiles(externalRoot)) {
      const parsed = parseSkillFrontmatter(await readFile(skillPath, "utf8"));
      const name = parsed.name ?? path.basename(path.dirname(skillPath));
      candidates.push({
        rank: 100 - rootIndex,
        resource: await createSkillResource({
          context,
          providerVersion,
          skillPath,
          name,
          scope: "user",
          origin: "hermes-external",
          state: parsed.error ? "invalid" : "active",
          metadata: {
            description: parsed.description ?? "",
            pruningEligible: false,
            readOnlySource: true,
          },
          ...(parsed.error ? { error: parsed.error } : {}),
          displayRoots: [[`$EXTERNAL_SKILLS_${rootIndex + 1}`, externalRoot]],
        }),
      });
    }
  }

  resolveSkillPrecedence(candidates);
  return candidates.map(({ resource }) => resource);
}

async function createSkillResource(options: {
  context: ScanContext;
  providerVersion: string;
  skillPath: string;
  name: string;
  scope: ResourceScope;
  origin: string;
  state: ResourceState;
  metadata: Record<string, JsonValue>;
  error?: string;
  displayRoots?: ReadonlyArray<readonly [string, string]>;
}): Promise<ResourceRecord> {
  const shownPath = displayPath(
    options.skillPath,
    options.context,
    options.displayRoots ?? [["$HERMES_HOME", getHermesHome(options.context)]],
  );
  const id = resourceId("hermes", "skill", `${options.origin}:${shownPath}`);
  return {
    id,
    kind: "skill",
    provider: "hermes",
    providerVersion: options.providerVersion,
    name: options.name,
    scope: options.scope,
    origin: options.origin,
    owner: { type: "self" },
    path: await canonicalPath(options.skillPath),
    displayPath: shownPath,
    state: options.state,
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${shownPath}`,
    capabilities: ["inspect", "open"],
    metadata: options.metadata,
    findings: options.error
      ? [
          {
            code: "hermes.skill.invalid-frontmatter",
            severity: "error",
            confidence: "high",
            message: options.error,
            resourceId: id,
          },
        ]
      : [],
  };
}

function resolveSkillPrecedence(candidates: SkillCandidate[]): void {
  for (const name of new Set(candidates.map(({ resource }) => resource.name))) {
    const ranked = candidates
      .filter(
        ({ resource }) => resource.name === name && resource.state !== "invalid",
      )
      .sort(
        (left, right) =>
          right.rank - left.rank || compareResources(left.resource, right.resource),
      );
    const winner = ranked[0]?.resource;
    if (!winner) {
      continue;
    }
    winner.state = "active";
    for (const candidate of ranked.slice(1)) {
      candidate.resource.state = "shadowed";
      candidate.resource.precedence = { shadowedBy: winner.id };
    }
  }
}

async function readBundledManifest(candidate: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    for (const rawLine of (await readFile(candidate, "utf8")).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const separator = line.indexOf(":");
      result.set(
        separator === -1 ? line : line.slice(0, separator).trim(),
        separator === -1 ? "" : line.slice(separator + 1).trim(),
      );
    }
  } catch {
    return result;
  }
  return result;
}

async function readHubEntries(
  candidate: string,
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  const parsed = await readJsonFile(candidate);
  if (!isRecord(parsed) || !isRecord(parsed.installed)) {
    return result;
  }
  for (const [name, value] of Object.entries(parsed.installed)) {
    if (isRecord(value)) {
      result.set(name, value);
    }
  }
  return result;
}

async function directoryHash(directory: string): Promise<string> {
  const hash = createHash("md5");
  for (const file of await listFiles(directory)) {
    hash.update(path.relative(directory, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function listFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(candidate)));
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files;
}

function expandHermesPath(
  candidate: string,
  context: ScanContext,
): string | undefined {
  let missingEnvironment = false;
  const expandedEnvironment = candidate.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, name: string) => {
      const value = context.environment[name] ?? process.env[name];
      if (value === undefined) {
        missingEnvironment = true;
        return match;
      }
      return value;
    },
  );
  if (missingEnvironment) {
    return undefined;
  }
  if (expandedEnvironment === "~") {
    return context.homeDirectory;
  }
  if (expandedEnvironment.startsWith(`~${path.sep}`)) {
    return path.join(context.homeDirectory, expandedEnvironment.slice(2));
  }
  return path.resolve(expandedEnvironment);
}

async function discoverPlugins(
  context: ScanContext,
  providerVersion: string,
  hermesHome: string,
  config: Record<string, unknown>,
): Promise<ResourceRecord[]> {
  const pluginConfig = isRecord(config.plugins) ? config.plugins : {};
  const enabled = new Set(stringArray(pluginConfig.enabled));
  const disabled = new Set(stringArray(pluginConfig.disabled));
  const entries = isRecord(pluginConfig.entries) ? pluginConfig.entries : {};
  const projectTrustEnabled = environmentFlag(
    context.environment.HERMES_ENABLE_PROJECT_PLUGINS,
  );
  const sources: Array<{
    root: string;
    scope: ResourceScope;
    origin: string;
  }> = [
    {
      root: path.join(hermesHome, "plugins"),
      scope: "user",
      origin: "hermes-user-plugin",
    },
    {
      root: path.join(context.repositoryPath, ".hermes", "plugins"),
      scope: "project",
      origin: "hermes-project-plugin",
    },
  ];
  const resources: ResourceRecord[] = [];

  for (const source of sources) {
    for (const manifestPath of await findNamedFiles(source.root, new Set(["plugin.yaml"]))) {
      const manifest = await readYamlFile(manifestPath);
      const parsed = isRecord(manifest) ? manifest : {};
      const fallbackName = path.basename(path.dirname(manifestPath));
      const name = stringValue(parsed.name) ?? fallbackName;
      const entry = isRecord(entries[name]) ? entries[name] : {};
      const requiredEnvironment = stringArray(parsed.requires_env);
      const missingEnvironment = requiredEnvironment.filter(
        (variable) => !context.environment[variable] && !process.env[variable],
      );
      const isProjectBlocked = source.scope === "project" && !projectTrustEnabled;
      const state: ResourceState = !isRecord(manifest)
        ? "invalid"
        : disabled.has(name)
          ? "disabled"
          : isProjectBlocked || missingEnvironment.length > 0
            ? "blocked"
            : enabled.has(name)
              ? "active"
              : "inactive";
      const shownPath = displayPath(manifestPath, context, [
        ["$HERMES_HOME", hermesHome],
      ]);
      const id = resourceId("hermes", "plugin", `${source.origin}:${name}`);
      const findings: Finding[] = [];
      if (!isRecord(manifest)) {
        findings.push({
          code: "hermes.plugin.invalid-manifest",
          severity: "error",
          confidence: "high",
          message: "The Hermes plugin manifest is not valid YAML.",
          resourceId: id,
        });
      } else if (isProjectBlocked) {
        findings.push({
          code: "hermes.plugin.project-trust-blocked",
          severity: "warning",
          confidence: "high",
          message: "The project plugin is blocked until project plugin discovery is explicitly enabled.",
          resourceId: id,
        });
      } else if (missingEnvironment.length > 0) {
        findings.push({
          code: "hermes.plugin.missing-environment",
          severity: "warning",
          confidence: "high",
          message: "The plugin is missing one or more required environment variables.",
          resourceId: id,
        });
      }
      resources.push({
        id,
        kind: "plugin",
        provider: "hermes",
        providerVersion,
        name,
        scope: source.scope,
        origin: source.origin,
        owner: { type: "self" },
        path: await canonicalPath(path.dirname(manifestPath)),
        displayPath: shownPath,
        state,
        precedence: {},
        evidenceType: "parsed",
        evidenceReceipt: `file:${shownPath}`,
        capabilities: ["inspect", "open"],
        metadata: {
          version: stringValue(parsed.version) ?? "unknown",
          enabledByConfig: enabled.has(name),
          disabledByConfig: disabled.has(name),
          projectTrustEnabled,
          requiredEnvironmentVariableNames: requiredEnvironment.sort(),
          missingEnvironmentVariableNames: missingEnvironment.sort(),
          mcpAllowlist: stringArray(entry.mcp_allowlist).sort(),
        },
        findings,
      });
    }
  }

  return resources;
}

async function discoverPluginSkills(
  context: ScanContext,
  providerVersion: string,
  plugins: ResourceRecord[],
): Promise<ResourceRecord[]> {
  const resources: ResourceRecord[] = [];
  for (const plugin of plugins) {
    const pluginRoot = plugin.path;
    if (!pluginRoot) {
      continue;
    }
    for (const skillPath of await findSkillFiles(path.join(pluginRoot, "skills"))) {
      const parsed = parseSkillFrontmatter(await readFile(skillPath, "utf8"));
      const bareName = parsed.name ?? path.basename(path.dirname(skillPath));
      const name = `${plugin.name}:${bareName}`;
      const shownPath = displayPath(skillPath, context, [
        ["$HERMES_HOME", getHermesHome(context)],
      ]);
      const id = resourceId("hermes", "skill", `plugin:${plugin.id}:${name}`);
      resources.push({
        id,
        kind: "skill",
        provider: "hermes",
        providerVersion,
        name,
        scope: plugin.scope,
        origin: "hermes-plugin",
        owner: { type: "plugin", id: plugin.name },
        path: await canonicalPath(skillPath),
        displayPath: shownPath,
        state: parsed.error ? "invalid" : plugin.state,
        precedence: {},
        evidenceType: "parsed",
        evidenceReceipt: `file:${shownPath}`,
        capabilities: ["inspect", "open"],
        metadata: {
          description: parsed.description ?? "",
          pruningEligible: false,
        },
        findings: parsed.error
          ? [
              {
                code: "hermes.skill.invalid-frontmatter",
                severity: "error",
                confidence: "high",
                message: parsed.error,
                resourceId: id,
              },
            ]
          : [],
      });
    }
  }
  return resources;
}

async function discoverMcpServers(
  context: ScanContext,
  providerVersion: string,
  configPath: string,
  config: Record<string, unknown>,
): Promise<ResourceRecord[]> {
  const servers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
  const shownPath = displayPath(configPath, context, [
    ["$HERMES_HOME", getHermesHome(context)],
  ]);
  const resources: ResourceRecord[] = [];

  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) {
      continue;
    }
    resources.push({
      id: resourceId("hermes", "mcp", `${shownPath}:${name}`),
      kind: "mcp",
      provider: "hermes",
      providerVersion,
      name,
      scope: "user",
      origin: "hermes-config",
      owner: { type: "self" },
      path: await canonicalPath(configPath),
      displayPath: shownPath,
      state: value.enabled === false ? "disabled" : "active",
      precedence: {},
      evidenceType: "parsed",
      evidenceReceipt: `file:${shownPath}`,
      capabilities: ["inspect"],
      metadata: {
        ...sanitizeTransport(value),
        enabled: value.enabled !== false,
        allowedTools: stringArray(value.tools).sort(),
      },
      findings: [],
    });
  }

  return resources;
}

function environmentFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function compareResources(left: ResourceRecord, right: ResourceRecord): number {
  return `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
    `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
  );
}
