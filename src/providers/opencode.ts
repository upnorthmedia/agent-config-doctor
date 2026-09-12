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
  JsonValue,
  ResourceRecord,
  ResourceScope,
} from "../core/schema.ts";
import {
  canonicalPath,
  directoriesFromRoot,
  displayPath,
  findNamedFiles,
  findSkillFiles,
  isDirectory,
  isRecord,
  parseSemanticVersion,
  parseSkillFrontmatter,
  reachForDirectory,
  resourceId,
  runCommand,
  sanitizeUrl,
  stringArray,
  stringValue,
} from "./shared.ts";

interface ConfigSource {
  filePath: string;
  scope: "user" | "project";
  order: number;
  config: Record<string, unknown>;
}

interface RankedResource {
  resource: ResourceRecord;
  rank: number;
  eligible: boolean;
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly provider = "opencode" as const;
  readonly capabilities: AdapterCapabilities = {
    resourceKinds: ["instruction", "skill", "plugin", "mcp", "agent"],
    nativeInspection: false,
  };

  async detect(context: ScanContext): Promise<ProviderDetection> {
    const executablePath = context.executables?.opencode ?? "opencode";
    const result = runCommand(executablePath, ["--version"], context, 2_000);
    const version = parseSemanticVersion(result.stdout);
    const installed = result.status === 0;
    const major = version === "unknown" ? undefined : Number(version.split(".")[0]);
    const generation =
      major === undefined
        ? "unknown"
        : major === 2
          ? "v2"
          : major < 2
            ? "legacy"
            : "future";
    const userRoot = opencodeUserRoot(context);
    const projectRoot = path.join(context.repositoryPath, ".opencode");
    const configRoots = [userRoot];
    if (await isDirectory(projectRoot)) {
      configRoots.push(projectRoot);
    }

    return {
      provider: this.provider,
      installed,
      version,
      support: !installed
        ? "unavailable"
        : generation === "v2"
          ? "supported"
          : "unsupported",
      generation,
      executablePath,
      configRoots,
    };
  }

  async discover(
    context: ScanContext,
    detection: ProviderDetection,
  ): Promise<ResourceRecord[]> {
    if (detection.support !== "supported" || detection.generation !== "v2") {
      return [];
    }
    const userRoot = opencodeUserRoot(context);
    const configSources = await discoverConfigSources(context, userRoot);
    const instructions = await discoverInstructions(
      context,
      detection.version,
      userRoot,
      configSources,
    );
    const skills = await discoverSkills(context, detection.version, userRoot);
    const configResources = await discoverConfigResources(
      context,
      detection.version,
      configSources,
    );

    return [...instructions, ...skills, ...configResources].sort(compareResources);
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
        resource.kind === "instruction" &&
        resource.origin === "opencode-agents"
          ? ("inactive" as const)
          : resource.state,
    }));
    const orderedResourceIds: string[] = [];
    let order = 0;
    const globalInstruction = resolved.find(
      (resource) =>
        resource.kind === "instruction" &&
        resource.scope === "user" &&
        resource.origin === "opencode-agents",
    );
    if (globalInstruction) {
      activateInstruction(globalInstruction, order);
      orderedResourceIds.push(globalInstruction.id);
      order += 1;
    }

    const directories = directoriesFromRoot(
      context.repositoryPath,
      context.workingDirectory,
    ).reverse();
    for (const directory of directories) {
      const instruction = resolved.find(
        (resource) =>
          resource.kind === "instruction" &&
          resource.origin === "opencode-agents" &&
          resource.metadata.loadDirectory === directory,
      );
      if (!instruction) {
        continue;
      }
      activateInstruction(instruction, order);
      orderedResourceIds.push(instruction.id);
      order += 1;
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
    if (resource.origin === "opencode-config-instructions") {
      return "Configured in V2, but not resolved or loaded by OpenCode V2.";
    }
    if (resource.state === "invalid") {
      return "The resource failed deterministic validation.";
    }
    if (resource.state === "shadowed") {
      return "A later OpenCode source provides the same resource identity.";
    }
    if (resource.state === "active") {
      return resource.kind === "instruction"
        ? "Loaded in the effective OpenCode V2 instruction order."
        : "Selected by OpenCode V2 source precedence.";
    }
    return "Installed, but inactive for this OpenCode V2 workspace.";
  }
}

function opencodeUserRoot(context: ScanContext): string {
  if (context.environment.OPENCODE_CONFIG_DIR) {
    return path.resolve(context.environment.OPENCODE_CONFIG_DIR);
  }
  const configHome = context.environment.XDG_CONFIG_HOME
    ? path.resolve(context.environment.XDG_CONFIG_HOME)
    : path.join(context.homeDirectory, ".config");
  return path.join(configHome, "opencode");
}

async function discoverInstructions(
  context: ScanContext,
  providerVersion: string,
  userRoot: string,
  configSources: ConfigSource[],
): Promise<ResourceRecord[]> {
  const paths = [
    path.join(userRoot, "AGENTS.md"),
    ...(await findNamedFiles(context.repositoryPath, new Set(["AGENTS.md"]))),
  ];
  const resources: ResourceRecord[] = [];
  for (const candidate of paths) {
    const shownPath = displayPath(candidate, context);
    const loadDirectory = path.dirname(candidate);
    resources.push({
      id: resourceId("opencode", "instruction", shownPath),
      kind: "instruction",
      provider: "opencode",
      providerVersion,
      name: "AGENTS.md",
      scope: candidate.startsWith(userRoot) ? "user" : "project",
      origin: "opencode-agents",
      owner: { type: "self" },
      path: await canonicalPath(candidate),
      displayPath: shownPath,
      reach: candidate.startsWith(userRoot)
        ? "chain"
        : reachForDirectory(loadDirectory, context),
      state: "inactive",
      precedence: {},
      evidenceType: "parsed",
      evidenceReceipt: `file:${shownPath}`,
      capabilities: ["inspect", "open"],
      metadata: { loadDirectory },
      findings: [],
    });
  }

  for (const source of configSources) {
    const sourceDisplayPath = displayPath(source.filePath, context);
    for (const configured of stringArray(source.config.instructions)) {
      const target = resolveConfigPath(source.filePath, configured, context);
      const shownPath = displayPath(target, context);
      resources.push({
        id: resourceId(
          "opencode",
          "instruction",
          `configured:${sourceDisplayPath}:${configured}`,
        ),
        kind: "instruction",
        provider: "opencode",
        providerVersion,
        name: path.basename(configured),
        scope: source.scope,
        origin: "opencode-config-instructions",
        owner: { type: "self" },
        displayPath: shownPath,
        state: "inactive",
        precedence: { configOrder: source.order },
        evidenceType: "parsed",
        evidenceReceipt: `file:${sourceDisplayPath}`,
        capabilities: ["inspect"],
        metadata: {
          configuredOnly: true,
          configSource: sourceDisplayPath,
        },
        findings: [],
      });
    }
  }
  return resources;
}

async function discoverSkills(
  context: ScanContext,
  providerVersion: string,
  userRoot: string,
): Promise<ResourceRecord[]> {
  const chain = directoriesFromRoot(context.repositoryPath, context.workingDirectory);
  const locations: Array<{
    skillPath: string;
    scope: ResourceScope;
    origin: string;
    rank: number;
    eligible: boolean;
    reach?: ResourceRecord["reach"];
  }> = [];
  const globalRoots = [
    {
      root: path.join(context.homeDirectory, ".claude", "skills"),
      origin: "claude-compatibility",
      rank: 100,
    },
    {
      root: path.join(context.homeDirectory, ".agents", "skills"),
      origin: "agent-compatibility",
      rank: 200,
    },
    {
      root: path.join(userRoot, "skills"),
      origin: "opencode-global",
      rank: 300,
    },
  ];
  for (const global of globalRoots) {
    for (const skillPath of await findSkillFiles(global.root)) {
      locations.push({
        skillPath,
        scope: "user",
        origin: global.origin,
        rank: global.rank,
        eligible: true,
      });
    }
  }

  for (const skillPath of await findSkillFiles(context.repositoryPath)) {
    const source = opencodeProjectSkillSource(skillPath);
    if (!source) {
      continue;
    }
    const depth = chain.indexOf(source.scopeDirectory);
    locations.push({
      skillPath,
      scope: "project",
      origin: source.origin,
      rank: source.baseRank + Math.max(depth, 0),
      eligible: depth >= 0,
      reach: reachForDirectory(source.scopeDirectory, context),
    });
  }

  const ranked: RankedResource[] = [];
  for (const location of locations) {
    const contents = await readFile(location.skillPath, "utf8");
    const parsed = parseSkillFrontmatter(contents);
    const name = parsed.name ?? path.basename(path.dirname(location.skillPath));
    const shownPath = displayPath(location.skillPath, context);
    const id = resourceId("opencode", "skill", shownPath);
    ranked.push({
      rank: location.rank,
      eligible: location.eligible,
      resource: {
        id,
        kind: "skill",
        provider: "opencode",
        providerVersion,
        name,
        scope: location.scope,
        origin: location.origin,
        owner: { type: "self" },
        path: await canonicalPath(location.skillPath),
        displayPath: shownPath,
        ...(location.reach ? { reach: location.reach } : {}),
        state: parsed.error
          ? "invalid"
          : location.eligible
            ? "active"
            : "inactive",
        precedence: {},
        evidenceType: "parsed",
        evidenceReceipt: `file:${shownPath}`,
        capabilities: ["inspect", "open"],
        metadata: {
          description: parsed.description ?? "",
          displayName: parsed.name ?? name,
        },
        findings: parsed.error
          ? [
              {
                code: "opencode.skill.invalid-frontmatter",
                severity: "error",
                confidence: "high",
                message: parsed.error,
                resourceId: id,
              },
            ]
          : [],
      },
    });
  }
  resolveRankedResources(ranked);
  return ranked.map(({ resource }) => resource);
}

function opencodeProjectSkillSource(skillPath: string):
  | { scopeDirectory: string; origin: string; baseRank: number }
  | undefined {
  const resolved = path.resolve(skillPath);
  for (const source of [
    { marker: `${path.sep}.claude${path.sep}skills${path.sep}`, origin: "claude-compatibility", baseRank: 100 },
    { marker: `${path.sep}.agents${path.sep}skills${path.sep}`, origin: "agent-compatibility", baseRank: 200 },
    { marker: `${path.sep}.opencode${path.sep}skills${path.sep}`, origin: "opencode-project", baseRank: 400 },
  ]) {
    const index = resolved.lastIndexOf(source.marker);
    if (index >= 0) {
      return {
        scopeDirectory: resolved.slice(0, index) || path.sep,
        origin: source.origin,
        baseRank: source.baseRank,
      };
    }
  }
  return undefined;
}

async function discoverConfigSources(
  context: ScanContext,
  userRoot: string,
): Promise<ConfigSource[]> {
  const sources: ConfigSource[] = [];
  const globalPath = await firstConfigFile(userRoot);
  if (globalPath) {
    const config = await readJsoncFile(globalPath);
    if (config) {
      sources.push({ filePath: globalPath, scope: "user", order: 0, config });
    }
  }
  const chain = directoriesFromRoot(context.repositoryPath, context.workingDirectory);
  for (const directory of chain) {
    const directPath = await firstConfigFile(directory);
    if (directPath) {
      const config = await readJsoncFile(directPath);
      if (config) {
        sources.push({
          filePath: directPath,
          scope: "project",
          order: sources.length,
          config,
        });
      }
    }
  }
  for (const directory of chain) {
    const nestedPath = await firstConfigFile(path.join(directory, ".opencode"));
    if (nestedPath) {
      const config = await readJsoncFile(nestedPath);
      if (config) {
        sources.push({
          filePath: nestedPath,
          scope: "project",
          order: sources.length,
          config,
        });
      }
    }
  }
  return sources;
}

async function firstConfigFile(directory: string): Promise<string | undefined> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(directory, name);
    if (await isDirectory(directory)) {
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

async function readJsoncFile(
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

async function discoverConfigResources(
  context: ScanContext,
  providerVersion: string,
  sources: ConfigSource[],
): Promise<ResourceRecord[]> {
  const ranked: RankedResource[] = [];
  for (const source of sources) {
    const shownPath = displayPath(source.filePath, context);
    for (const plugin of stringArray(source.config.plugin)) {
      ranked.push({
        rank: source.order,
        eligible: true,
        resource: {
          id: resourceId("opencode", "plugin", `${shownPath}:${plugin}`),
          kind: "plugin",
          provider: "opencode",
          providerVersion,
          name: plugin,
          scope: source.scope,
          origin: "opencode-config",
          owner: { type: "self" },
          path: await canonicalPath(source.filePath),
          displayPath: shownPath,
          state: "active",
          precedence: { configOrder: source.order },
          evidenceType: "parsed",
          evidenceReceipt: `file:${shownPath}`,
          capabilities: ["inspect"],
          metadata: {},
          findings: [],
        },
      });
    }
    const mcp = isRecord(source.config.mcp) ? source.config.mcp : {};
    for (const [name, rawServer] of Object.entries(mcp)) {
      if (!isRecord(rawServer)) {
        continue;
      }
      ranked.push({
        rank: source.order,
        eligible: true,
        resource: {
          id: resourceId("opencode", "mcp", `${shownPath}:${name}`),
          kind: "mcp",
          provider: "opencode",
          providerVersion,
          name,
          scope: source.scope,
          origin: "opencode-config",
          owner: { type: "self" },
          path: await canonicalPath(source.filePath),
          displayPath: shownPath,
          state: rawServer.enabled === false ? "disabled" : "active",
          precedence: { configOrder: source.order },
          evidenceType: "parsed",
          evidenceReceipt: `file:${shownPath}`,
          capabilities: ["inspect"],
          metadata: sanitizeOpenCodeMcp(rawServer),
          findings: [],
        },
      });
    }
  }
  resolveRankedResources(ranked);
  return ranked.map(({ resource }) => resource);
}

function sanitizeOpenCodeMcp(
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

function resolveRankedResources(records: RankedResource[]): void {
  const groups = new Map<string, RankedResource[]>();
  for (const record of records) {
    const key = `${record.resource.kind}:${record.resource.name}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const candidates = group
      .filter(
        (record) =>
          record.eligible &&
          record.resource.state !== "invalid" &&
          record.resource.state !== "disabled",
      )
      .sort((left, right) => right.rank - left.rank);
    const winner = candidates[0]?.resource;
    if (!winner) {
      continue;
    }
    winner.state = "active";
    winner.precedence = { ...winner.precedence, priority: candidates[0]?.rank ?? 0 };
    for (const candidate of candidates.slice(1)) {
      candidate.resource.state = "shadowed";
      candidate.resource.precedence = {
        ...candidate.resource.precedence,
        shadowedBy: winner.id,
      };
    }
  }
}

function resolveConfigPath(
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

function activateInstruction(resource: ResourceRecord, order: number): void {
  resource.state = "active";
  resource.precedence = { ...resource.precedence, chainOrder: order };
}

function compareResources(left: ResourceRecord, right: ResourceRecord): number {
  return `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
    `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
  );
}
