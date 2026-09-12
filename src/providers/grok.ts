import { readFile } from "node:fs/promises";
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
  ResourceRecord,
  ResourceScope,
  ResourceState,
} from "../core/schema.ts";
import {
  canonicalPath,
  displayPath,
  findNamedFiles,
  findSkillFiles,
  isDirectory,
  isFile,
  isRecord,
  isWithin,
  nativeNotice,
  parseSemanticVersion,
  parseSkillFrontmatter,
  reachForDirectory,
  resourceId,
  runCommand,
  runNativeJson,
  stringArray,
  stringValue,
} from "./shared.ts";

const INSTRUCTION_NAMES = new Set([
  "Agents.md",
  "Claude.md",
  "AGENT.md",
  "AGENTS.md",
]);

export class GrokAdapter implements ProviderAdapter {
  readonly provider = "grok" as const;
  readonly capabilities: AdapterCapabilities = {
    resourceKinds: ["instruction", "skill", "plugin", "mcp", "hook", "agent"],
    nativeInspection: true,
  };

  async detect(context: ScanContext): Promise<ProviderDetection> {
    const executablePath = context.executables?.grok ?? "grok";
    const result = await runCommand(executablePath, ["--version"], context, 2_000);
    const version = parseSemanticVersion(result.stdout);
    const installed = result.status === 0;
    const userRoot = path.join(context.homeDirectory, ".grok");
    const projectRoot = path.join(context.repositoryPath, ".grok");
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
        : /^1\.0\./.test(version)
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
    const outcome = await runNativeJson(
      detection.executablePath,
      ["inspect", "--json"],
      context,
    );
    if (!outcome.ok) {
      return {
        resources: [],
        notices: [
          nativeNotice(
            "grok",
            "grok inspect --json",
            outcome,
            "All Grok Build evidence",
          ),
        ],
      };
    }
    const payload = outcome.payload;
    if (!isRecord(payload)) {
      return {
        resources: [],
        notices: [
          nativeNotice(
            "grok",
            "grok inspect --json",
            { ok: false, failure: "malformed-json", detail: "unexpected JSON shape" },
            "All Grok Build evidence",
          ),
        ],
      };
    }
    const pluginResources = await parsePlugins(payload, context, detection.version);
    const instructions = await parseInstructions(
      payload,
      context,
      detection.version,
    );
    const skills = await parseSkills(
      payload,
      context,
      detection.version,
      pluginResources,
    );
    const mcps = await parseMcpServers(
      payload,
      context,
      detection.version,
      pluginResources,
    );

    return {
      resources: [...instructions, ...skills, ...pluginResources, ...mcps].sort(
        compareResources,
      ),
      notices: [],
    };
  }

  async resolveEffective(
    context: ScanContext,
    resources: ResourceRecord[],
    detection: ProviderDetection,
  ): Promise<EffectiveConfiguration> {
    const resolved = resources.map((resource) => ({
      ...resource,
      precedence: { ...resource.precedence },
    }));
    const orderedResourceIds = resolved
      .filter(
        (resource) =>
          resource.kind === "instruction" &&
          resource.state === "active" &&
          typeof resource.precedence.nativeOrder === "number",
      )
      .sort(
        (left, right) =>
          (left.precedence.nativeOrder as number) -
          (right.precedence.nativeOrder as number),
      )
      .map((resource, chainOrder) => {
        resource.precedence = { ...resource.precedence, chainOrder };
        return resource.id;
      });

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
    if (resource.state === "blocked") {
      return "The resource is enabled but blocked by Grok trust or policy.";
    }
    if (resource.state === "disabled") {
      return "The resource is installed but explicitly disabled.";
    }
    if (resource.state === "shadowed") {
      return "A higher-priority skill with the same name is active.";
    }
    if (resource.state === "active") {
      return resource.kind === "instruction"
        ? "Reported by grok inspect in the effective instruction chain."
        : "Reported by grok inspect as available.";
    }
    return "Discovered, but not active for this working directory.";
  }
}

async function parseInstructions(
  payload: Record<string, unknown>,
  context: ScanContext,
  providerVersion: string,
): Promise<ResourceRecord[]> {
  const nativeInstructions = Array.isArray(payload.projectInstructions)
    ? payload.projectInstructions
    : [];
  const nativeByPath = new Map<string, { raw: Record<string, unknown>; order: number }>();
  for (const [order, value] of nativeInstructions.entries()) {
    if (!isRecord(value)) {
      continue;
    }
    const rawPath = stringValue(value.path);
    if (rawPath) {
      nativeByPath.set(path.resolve(rawPath), { raw: value, order });
    }
  }

  const userCandidates = [
    ...["Agents.md", "Claude.md", "AGENT.md", "AGENTS.md"].map((name) =>
      path.join(context.homeDirectory, ".grok", name),
    ),
    ...["Agents.md", "Claude.md", "AGENT.md", "AGENTS.md"].map((name) =>
      path.join(context.homeDirectory, ".claude", name),
    ),
  ];
  const candidates = [
    ...userCandidates,
    ...(await findNamedFiles(context.repositoryPath, INSTRUCTION_NAMES)),
  ];
  const resources: ResourceRecord[] = [];

  for (const candidate of candidates) {
    if (!(await isFile(candidate))) {
      continue;
    }
    const resolvedPath = path.resolve(candidate);
    const native = nativeByPath.get(resolvedPath);
    const raw = native?.raw;
    const shownPath = displayPath(candidate, context);
    const compatibilityStatus = stringValue(raw?.compatibilityStatus);
    const vendor = stringValue(raw?.vendor);
    const scope: ResourceScope = isWithin(context.repositoryPath, candidate)
      ? "project"
      : "user";
    const active = native !== undefined && compatibilityStatus !== "disabled";
    const id = resourceId("grok", "instruction", shownPath);
    resources.push({
      id,
      kind: "instruction",
      provider: "grok",
      providerVersion,
      name: path.basename(candidate),
      scope,
      origin: vendor ? `compatibility:${vendor}` : "grok-instruction",
      owner: { type: "self" },
      path: await canonicalPath(candidate),
      displayPath: shownPath,
      reach:
        native || scope === "user"
          ? "chain"
          : reachForDirectory(path.dirname(candidate), context),
      state: active ? "active" : "inactive",
      precedence: native ? { nativeOrder: native.order } : {},
      evidenceType: native ? "native" : "parsed",
      evidenceReceipt: native
        ? "command:grok inspect --json"
        : `file:${shownPath}`,
      capabilities: ["inspect", "open"],
      metadata: {
        loadDirectory: path.dirname(candidate),
        ...(compatibilityStatus ? { compatibilityStatus } : {}),
        ...(vendor ? { compatibilityVendor: vendor } : {}),
      },
      findings: [],
    });
  }

  const activeByDirectory = new Map<string, ResourceRecord[]>();
  for (const resource of resources.filter((item) => item.state === "active")) {
    const directory = String(resource.metadata.loadDirectory);
    const group = activeByDirectory.get(directory) ?? [];
    group.push(resource);
    activeByDirectory.set(directory, group);
  }
  for (const group of activeByDirectory.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const resource of group) {
      resource.findings.push({
        code: "grok.instruction.multiple-loaded",
        severity: "warning",
        confidence: "high",
        message: "Multiple Grok instruction filenames load from the same directory.",
        resourceId: resource.id,
      });
    }
  }

  return resources;
}

async function parsePlugins(
  payload: Record<string, unknown>,
  context: ScanContext,
  providerVersion: string,
): Promise<ResourceRecord[]> {
  const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
  const resources: ResourceRecord[] = [];

  for (const value of plugins) {
    if (!isRecord(value)) {
      continue;
    }
    const name = stringValue(value.name);
    const pluginPath = stringValue(value.path);
    if (!name || !pluginPath) {
      continue;
    }
    const scope = value.scope === "project" ? "project" : "user";
    const enabled = value.enabled !== false;
    const trusted = value.trusted === true || (scope === "user" && value.trusted !== false);
    const state: ResourceState = !enabled
      ? "disabled"
      : trusted
        ? "active"
        : "blocked";
    const shownPath = displayPath(pluginPath, context);
    const provides = isRecord(value.provides) ? value.provides : {};
    resources.push({
      id: resourceId("grok", "plugin", name),
      kind: "plugin",
      provider: "grok",
      providerVersion,
      name,
      scope,
      origin: "grok-plugin",
      owner: { type: "self" },
      path: await canonicalPath(pluginPath),
      displayPath: shownPath,
      state,
      precedence: {},
      evidenceType: "native",
      evidenceReceipt: "command:grok inspect --json",
      capabilities: ["inspect"],
      metadata: {
        enabled,
        trusted,
        providedSkills: stringArray(provides.skills),
        providedMcpServers: stringArray(provides.mcpServers),
      },
      findings: [],
    });
  }
  return resources;
}

async function parseSkills(
  payload: Record<string, unknown>,
  context: ScanContext,
  providerVersion: string,
  plugins: ResourceRecord[],
): Promise<ResourceRecord[]> {
  const rows: Array<{ resource: ResourceRecord; rank: number }> = [];
  const nativeSkills = Array.isArray(payload.skills) ? payload.skills : [];
  const seenPaths = new Set<string>();

  for (const value of nativeSkills) {
    if (!isRecord(value) || !isRecord(value.source)) {
      continue;
    }
    const name = stringValue(value.name);
    const skillPath = stringValue(value.source.path);
    if (!name || !skillPath) {
      continue;
    }
    seenPaths.add(path.resolve(skillPath));
    const sourceType = stringValue(value.source.type) ?? "unknown";
    const pluginName = stringValue(value.source.plugin_name);
    const owner = pluginName
      ? ({ type: "plugin", id: pluginName } as const)
      : ({ type: "self" } as const);
    const pluginState = pluginName
      ? plugins.find((plugin) => plugin.name === pluginName)?.state
      : undefined;
    const state = pluginState ?? "active";
    const shownPath = displayPath(skillPath, context);
    rows.push({
      rank: skillRank(sourceType, shownPath),
      resource: {
        id: resourceId("grok", "skill", `${pluginName ?? "self"}:${shownPath}`),
        kind: "skill",
        provider: "grok",
        providerVersion,
        name,
        scope: pluginName ? "bundled" : sourceType === "project" ? "project" : "user",
        origin: pluginName ? "plugin" : sourceType,
        owner,
        path: await canonicalPath(skillPath),
        displayPath: shownPath,
        state,
        precedence: {},
        evidenceType: "native",
        evidenceReceipt: "command:grok inspect --json",
        capabilities: ["inspect", "open"],
        metadata: {
          description: stringValue(value.description) ?? "",
          userInvocable: value.userInvocable !== false,
        },
        findings: [],
      },
    });
  }

  for (const root of [
    path.join(context.homeDirectory, ".claude", "skills"),
    path.join(context.homeDirectory, ".agents", "skills"),
    path.join(context.repositoryPath, ".claude", "skills"),
    path.join(context.repositoryPath, ".agents", "skills"),
    path.join(context.repositoryPath, ".grok", "skills"),
  ]) {
    for (const skillPath of await findSkillFiles(root)) {
      if (seenPaths.has(path.resolve(skillPath))) {
        continue;
      }
      const contents = await readFile(skillPath, "utf8");
      const parsed = parseSkillFrontmatter(contents);
      const shownPath = displayPath(skillPath, context);
      const name = parsed.name ?? path.basename(path.dirname(skillPath));
      const compatible = shownPath.includes("/.claude/") || shownPath.includes("/.agents/");
      rows.push({
        rank: compatible ? 100 : 300,
        resource: {
          id: resourceId("grok", "skill", `self:${shownPath}`),
          kind: "skill",
          provider: "grok",
          providerVersion,
          name,
          scope: isWithin(context.repositoryPath, skillPath) ? "project" : "user",
          origin: compatible ? "compatibility" : "grok-native-path",
          owner: { type: "self" },
          path: await canonicalPath(skillPath),
          displayPath: shownPath,
          state: parsed.error ? "invalid" : "active",
          precedence: {},
          evidenceType: "parsed",
          evidenceReceipt: `file:${shownPath}`,
          capabilities: ["inspect", "open"],
          metadata: { description: parsed.description ?? "" },
          findings: parsed.error
            ? [
                {
                  code: "grok.skill.invalid-frontmatter",
                  severity: "error",
                  confidence: "high",
                  message: parsed.error,
                  resourceId: resourceId("grok", "skill", `self:${shownPath}`),
                },
              ]
            : [],
        },
      });
    }
  }

  resolveSkillPrecedence(rows);
  return rows.map(({ resource }) => resource);
}

function resolveSkillPrecedence(
  rows: Array<{ resource: ResourceRecord; rank: number }>,
): void {
  for (const name of new Set(rows.map(({ resource }) => resource.name))) {
    const candidates = rows
      .filter(
        ({ resource }) =>
          resource.name === name &&
          resource.owner.type !== "plugin" &&
          resource.state !== "invalid",
      )
      .sort((left, right) => right.rank - left.rank);
    const winner = candidates[0]?.resource;
    if (!winner) {
      continue;
    }
    winner.state = "active";
    for (const candidate of candidates.slice(1)) {
      candidate.resource.state = "shadowed";
      candidate.resource.precedence = { shadowedBy: winner.id };
    }
  }
}

async function parseMcpServers(
  payload: Record<string, unknown>,
  context: ScanContext,
  providerVersion: string,
  plugins: ResourceRecord[],
): Promise<ResourceRecord[]> {
  const servers = Array.isArray(payload.mcpServers) ? payload.mcpServers : [];
  const resources: ResourceRecord[] = [];
  for (const value of servers) {
    if (!isRecord(value) || !isRecord(value.source)) {
      continue;
    }
    const name = stringValue(value.name);
    const sourcePath = stringValue(value.source.path);
    if (!name || !sourcePath) {
      continue;
    }
    const pluginName = stringValue(value.source.plugin_name);
    const pluginState = pluginName
      ? plugins.find((plugin) => plugin.name === pluginName)?.state
      : undefined;
    const shownPath = displayPath(sourcePath, context);
    resources.push({
      id: resourceId("grok", "mcp", `${pluginName ?? "self"}:${name}:${shownPath}`),
      kind: "mcp",
      provider: "grok",
      providerVersion,
      name,
      scope: pluginName ? "bundled" : "user",
      origin: pluginName ? "plugin" : stringValue(value.source.type) ?? "grok-config",
      owner: pluginName ? { type: "plugin", id: pluginName } : { type: "self" },
      path: await canonicalPath(sourcePath),
      displayPath: shownPath,
      state: pluginState ?? "active",
      precedence: {},
      evidenceType: "native",
      evidenceReceipt: "command:grok inspect --json",
      capabilities: ["inspect"],
      metadata: {
        transportType: stringValue(value.transport) ?? "unknown",
        hasTarget: typeof value.target === "string",
      },
      findings: [],
    });
  }
  return resources;
}

function skillRank(sourceType: string, shownPath: string): number {
  if (sourceType === "project") {
    return 400;
  }
  if (shownPath.includes("/.grok/")) {
    return 300;
  }
  return 100;
}

function compareResources(left: ResourceRecord, right: ResourceRecord): number {
  return `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
    `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
  );
}
