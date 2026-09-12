/**
 * OpenCode 1.18.x rules.
 *
 * Every rule here follows the released 1.18.30 sources:
 * - packages/opencode/src/session/instruction.ts (instruction precedence)
 * - packages/opencode/src/skill/index.ts (skill locations and overrides)
 * - packages/opencode/src/config/config.ts, paths.ts, plugin.ts (config
 *   files, config directories, plugin discovery, plugin dedupe)
 * - packages/core/src/flag/flag.ts and effect/runtime-flags.ts (disable flags)
 *
 * Discovery is parse-only. The `opencode debug` commands were evaluated and
 * rejected: `debug config` prints provider API keys verbatim and `debug
 * skill` prints full skill bodies, and both write to the OpenCode database.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { SCHEMA_VERSION } from "../core/schema.ts";
import type {
  DiscoveryResult,
  ProviderDetection,
  ScanContext,
} from "../core/provider-adapter.ts";
import type {
  EffectiveConfiguration,
  Finding,
  ResourceRecord,
  ResourceScope,
} from "../core/schema.ts";
import {
  readJsoncFile,
  resolveConfigPath,
  sanitizeOpenCodeMcp,
} from "./opencode-config.ts";
import {
  canonicalPath,
  directoriesFromRoot,
  displayPath,
  findNamedFiles,
  findSkillFiles,
  isDirectory,
  isFile,
  isRecord,
  isWithin,
  reachForDirectory,
  resourceId,
  sanitizeUrl,
  stringArray,
  stringValue,
  walkFiles,
} from "./shared.ts";

const PROVIDER = "opencode" as const;
const BUILTIN_SKILL_NAME = "customize-opencode";

interface V1Paths {
  home: string;
  /** $XDG_CONFIG_HOME/opencode or ~/.config/opencode. */
  globalConfigDir: string;
  /** OPENCODE_CONFIG_DIR when set, otherwise the global config directory. */
  configDir: string;
  cacheDir: string;
  configFile?: string;
  extraConfigDir?: string;
  flags: {
    disableProjectConfig: boolean;
    disableClaudePrompt: boolean;
    disableClaudeSkills: boolean;
    disableExternalSkills: boolean;
  };
  displayRoots: ReadonlyArray<readonly [string, string]>;
}

interface ConfigSource {
  filePath: string;
  scope: "user" | "project";
  order: number;
  config: Record<string, unknown>;
  /** Directory-phase sources are the .opencode and OPENCODE_CONFIG_DIR files. */
  phase: "file" | "directory";
  disabledBy?: string;
}

interface ConfigDirectory {
  directory: string;
  scope: "user" | "project";
  disabledBy?: string;
}

export function openCodeV1Paths(context: ScanContext): V1Paths {
  const environment = context.environment;
  const home = context.homeDirectory;
  const globalConfigDir = path.join(
    environment.XDG_CONFIG_HOME
      ? path.resolve(environment.XDG_CONFIG_HOME)
      : path.join(home, ".config"),
    "opencode",
  );
  const extraConfigDir = environment.OPENCODE_CONFIG_DIR
    ? path.resolve(environment.OPENCODE_CONFIG_DIR)
    : undefined;
  const configFile = environment.OPENCODE_CONFIG
    ? path.resolve(environment.OPENCODE_CONFIG)
    : undefined;
  const disableClaude = truthy(environment.OPENCODE_DISABLE_CLAUDE_CODE);
  return {
    home,
    globalConfigDir,
    configDir: extraConfigDir ?? globalConfigDir,
    cacheDir: path.join(
      environment.XDG_CACHE_HOME
        ? path.resolve(environment.XDG_CACHE_HOME)
        : path.join(home, ".cache"),
      "opencode",
    ),
    ...(configFile ? { configFile } : {}),
    ...(extraConfigDir ? { extraConfigDir } : {}),
    flags: {
      disableProjectConfig: truthy(environment.OPENCODE_DISABLE_PROJECT_CONFIG),
      disableClaudePrompt:
        disableClaude || truthy(environment.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT),
      disableClaudeSkills:
        disableClaude || truthy(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS),
      disableExternalSkills: truthy(environment.OPENCODE_DISABLE_EXTERNAL_SKILLS),
    },
    displayRoots: extraConfigDir
      ? [["$OPENCODE_CONFIG_DIR", extraConfigDir]]
      : [],
  };
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "true" || normalized === "1";
}

export async function discoverV1(
  context: ScanContext,
  detection: ProviderDetection,
): Promise<DiscoveryResult> {
  const paths = openCodeV1Paths(context);
  const version = detection.version;
  const chain = directoriesFromRoot(context.repositoryPath, context.workingDirectory);
  const nearestFirst = [...chain].reverse();
  const { sources, directories } = await discoverConfigSources(context, paths, nearestFirst);
  const activeSources = sources.filter((source) => !source.disabledBy);
  const merged = mergeConfigs(activeSources);

  const instructions = await discoverInstructions(context, paths, version, nearestFirst, activeSources);
  const skills = await discoverSkills(context, paths, version, chain, nearestFirst, directories, merged);
  const plugins = await discoverPlugins(context, paths, version, sources, directories);
  const mcpServers = await discoverMcpServers(context, paths, version, sources);

  return {
    resources: [...instructions, ...skills, ...plugins, ...mcpServers].sort(compareResources),
    notices: [],
  };
}

export async function resolveEffectiveV1(
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
        typeof resource.precedence.chainOrder === "number",
    )
    .sort(
      (left, right) =>
        (left.precedence.chainOrder as number) - (right.precedence.chainOrder as number),
    )
    .map((resource) => resource.id);

  return {
    schemaVersion: SCHEMA_VERSION,
    provider: PROVIDER,
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
      reason: explainV1(resource),
    })),
  };
}

export function explainV1(resource: ResourceRecord): string {
  if (typeof resource.metadata.disabledBy === "string") {
    return `Disabled by ${resource.metadata.disabledBy} in the environment.`;
  }
  if (resource.state === "unavailable") {
    return "Referenced by OpenCode configuration, but the target does not exist.";
  }
  if (resource.state === "invalid") {
    return "The resource failed deterministic validation.";
  }
  if (resource.state === "disabled") {
    return "The resource is configured but disabled in the merged OpenCode configuration.";
  }
  if (resource.state === "shadowed") {
    if (resource.kind === "instruction") {
      return "A higher-precedence instruction file is loaded instead.";
    }
    return "A later OpenCode source defines the same name, and OpenCode keeps the last definition.";
  }
  if (resource.state === "active") {
    if (resource.kind === "instruction") {
      return resource.metadata.remote === true
        ? "Fetched from its URL at session start; content is not verified locally."
        : "Loaded in the effective OpenCode instruction order.";
    }
    if (resource.kind === "skill") {
      return resource.origin === "opencode-builtin"
        ? "Built into OpenCode 1.18 and available until a disk skill overrides it."
        : "Available on demand to OpenCode agents.";
    }
    return "Enabled in the merged OpenCode configuration.";
  }
  if (resource.kind === "skill" && resource.metadata.missingDescription === true) {
    return "Loaded, but OpenCode never surfaces a skill without a description.";
  }
  return "Discovered, but outside the effective configuration for this working directory.";
}

// ---------------------------------------------------------------------------
// Configuration sources
// ---------------------------------------------------------------------------

async function discoverConfigSources(
  context: ScanContext,
  paths: V1Paths,
  nearestFirst: string[],
): Promise<{ sources: ConfigSource[]; directories: ConfigDirectory[] }> {
  const sources: ConfigSource[] = [];
  const projectDisabled = paths.flags.disableProjectConfig
    ? "OPENCODE_DISABLE_PROJECT_CONFIG"
    : undefined;

  const push = async (
    filePath: string,
    scope: "user" | "project",
    phase: ConfigSource["phase"],
    disabledBy?: string,
  ): Promise<void> => {
    if (!(await isFile(filePath))) {
      return;
    }
    const config = await readJsoncFile(filePath);
    if (!config) {
      return;
    }
    sources.push({
      filePath,
      scope,
      order: sources.length,
      config,
      phase,
      ...(disabledBy ? { disabledBy } : {}),
    });
  };

  // Global files merge in this fixed order.
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    await push(path.join(paths.globalConfigDir, name), "user", "file");
  }
  if (paths.configFile) {
    await push(paths.configFile, "user", "file");
  }
  // Project files: root first, nearest last; opencode.jsonc wins over
  // opencode.json in the same directory.
  for (const directory of [...nearestFirst].reverse()) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      await push(path.join(directory, name), "project", "file", projectDisabled);
    }
  }

  const directories: ConfigDirectory[] = [
    { directory: paths.globalConfigDir, scope: "user" },
  ];
  for (const directory of nearestFirst) {
    const candidate = path.join(directory, ".opencode");
    if (await isDirectory(candidate)) {
      directories.push({
        directory: candidate,
        scope: "project",
        ...(projectDisabled ? { disabledBy: projectDisabled } : {}),
      });
    }
  }
  const homeOpencode = path.join(paths.home, ".opencode");
  if (await isDirectory(homeOpencode)) {
    directories.push({ directory: homeOpencode, scope: "user" });
  }
  if (paths.extraConfigDir && (await isDirectory(paths.extraConfigDir))) {
    directories.push({ directory: paths.extraConfigDir, scope: "user" });
  }
  const unique = directories.filter(
    (entry, index) =>
      directories.findIndex((other) => other.directory === entry.directory) === index,
  );

  for (const entry of unique) {
    if (
      path.basename(entry.directory) === ".opencode" ||
      entry.directory === paths.extraConfigDir
    ) {
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        await push(path.join(entry.directory, name), entry.scope, "directory", entry.disabledBy);
      }
    }
  }

  return { sources, directories: unique };
}

function mergeConfigs(sources: ConfigSource[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.config)) {
      const current = merged[key];
      if (isRecord(current) && isRecord(value)) {
        merged[key] = { ...current, ...value };
      } else if (Array.isArray(current) && Array.isArray(value)) {
        merged[key] = [...new Set([...current, ...value])];
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

async function discoverInstructions(
  context: ScanContext,
  paths: V1Paths,
  version: string,
  nearestFirst: string[],
  sources: ConfigSource[],
): Promise<ResourceRecord[]> {
  const resources: ResourceRecord[] = [];
  const loaded = new Set<string>();
  let chainOrder = 0;
  const activate = (resource: ResourceRecord): void => {
    resource.state = "active";
    resource.precedence = { ...resource.precedence, chainOrder };
    chainOrder += 1;
  };

  // Global: the first existing file wins.
  const globalCandidates: Array<{ filePath: string; origin: string; disabledBy?: string }> = [
    { filePath: path.join(paths.configDir, "AGENTS.md"), origin: "opencode-global" },
    {
      filePath: path.join(paths.home, ".claude", "CLAUDE.md"),
      origin: "claude-compatibility",
      ...(paths.flags.disableClaudePrompt
        ? { disabledBy: claudePromptFlag(context) }
        : {}),
    },
  ];
  let globalSelected: ResourceRecord | undefined;
  for (const candidate of globalCandidates) {
    if (!(await isFile(candidate.filePath))) {
      continue;
    }
    const resource = await createInstructionResource(candidate.filePath, context, paths, version, {
      scope: "user",
      origin: candidate.origin,
      reach: "chain",
      ...(candidate.disabledBy ? { disabledBy: candidate.disabledBy } : {}),
    });
    if (candidate.disabledBy) {
      resource.state = "disabled";
    } else if (!globalSelected) {
      globalSelected = resource;
      activate(resource);
      loaded.add(resource.path ?? candidate.filePath);
    } else {
      resource.state = "shadowed";
      resource.precedence = { shadowedBy: globalSelected.id };
    }
    resources.push(resource);
  }

  // Project: the first file name with any match on the chain wins, and every
  // ancestor copy of that name loads, nearest first.
  const projectNames = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
  const discovered = await findNamedFiles(context.repositoryPath, new Set(projectNames));
  const projectResources = new Map<string, ResourceRecord>();
  for (const filePath of discovered) {
    const directory = path.dirname(filePath);
    const claudeDisabled = path.basename(filePath) === "CLAUDE.md" && paths.flags.disableClaudePrompt;
    const disabledBy = paths.flags.disableProjectConfig
      ? "OPENCODE_DISABLE_PROJECT_CONFIG"
      : claudeDisabled
        ? claudePromptFlag(context)
        : undefined;
    const resource = await createInstructionResource(filePath, context, paths, version, {
      scope: "project",
      origin: "repository",
      reach: reachForDirectory(directory, context),
      ...(disabledBy ? { disabledBy } : {}),
    });
    if (disabledBy) {
      resource.state = "disabled";
    }
    projectResources.set(filePath, resource);
    resources.push(resource);
  }
  const onChain = (name: string): ResourceRecord[] =>
    nearestFirst.flatMap((directory) => {
      const resource = projectResources.get(path.join(directory, name));
      return resource && resource.state !== "disabled" ? [resource] : [];
    });
  let selectedProject: ResourceRecord[] = [];
  for (const name of projectNames) {
    const matches = onChain(name);
    if (matches.length > 0) {
      selectedProject = matches;
      break;
    }
  }
  for (const resource of selectedProject) {
    activate(resource);
    loaded.add(resource.path ?? "");
  }
  const winner = selectedProject[0];
  for (const resource of projectResources.values()) {
    if (
      winner &&
      resource.reach === "chain" &&
      resource.state === "inactive" &&
      !selectedProject.includes(resource)
    ) {
      resource.state = "shadowed";
      resource.precedence = { shadowedBy: winner.id };
    }
  }

  // config.instructions: paths are globs, relative entries resolve up the
  // chain, URLs are fetched at session start.
  const seenEntries = new Set<string>();
  for (const source of sources) {
    const sourceDisplay = displayPath(source.filePath, context, paths.displayRoots);
    for (const raw of stringArray(source.config.instructions)) {
      if (seenEntries.has(raw)) {
        continue;
      }
      seenEntries.add(raw);
      if (raw.startsWith("https://") || raw.startsWith("http://")) {
        const url = sanitizeUrl(raw);
        const id = resourceId(PROVIDER, "instruction", `configured-url:${sourceDisplay}:${url}`);
        const resource: ResourceRecord = {
          id,
          kind: "instruction",
          provider: PROVIDER,
          providerVersion: version,
          name: path.basename(new URL(url).pathname) || url,
          scope: source.scope,
          origin: "opencode-config-instructions",
          owner: { type: "self" },
          reach: "chain",
          state: "inactive",
          precedence: { configOrder: source.order },
          evidenceType: "inferred",
          evidenceReceipt: `file:${sourceDisplay}`,
          capabilities: ["inspect"],
          metadata: { remote: true, url, configSource: sourceDisplay },
          findings: [],
        };
        activate(resource);
        resources.push(resource);
        continue;
      }
      const matches = await resolveInstructionGlob(raw, context, paths, nearestFirst);
      if (matches.length === 0) {
        const shownPath = displayPath(resolveConfigPath(source.filePath, raw, context), context, paths.displayRoots);
        const id = resourceId(PROVIDER, "instruction", `configured:${sourceDisplay}:${raw}`);
        resources.push({
          id,
          kind: "instruction",
          provider: PROVIDER,
          providerVersion: version,
          name: path.basename(raw),
          scope: source.scope,
          origin: "opencode-config-instructions",
          owner: { type: "self" },
          displayPath: shownPath,
          reach: "chain",
          state: "unavailable",
          precedence: { configOrder: source.order },
          evidenceType: "parsed",
          evidenceReceipt: `file:${sourceDisplay}`,
          capabilities: ["inspect"],
          metadata: { configSource: sourceDisplay, pattern: raw },
          findings: [
            {
              code: "opencode.instruction.missing-reference",
              severity: "warning",
              confidence: "high",
              message: `The instructions entry ${raw} in ${sourceDisplay} matches no file.`,
              resourceId: id,
            },
          ],
        });
        continue;
      }
      for (const match of matches) {
        const canonical = await canonicalPath(match);
        if (loaded.has(canonical)) {
          continue;
        }
        loaded.add(canonical);
        const resource = await createInstructionResource(match, context, paths, version, {
          scope: source.scope,
          origin: "opencode-config-instructions",
          reach: "chain",
        });
        resource.precedence = { configOrder: source.order };
        resource.metadata.configSource = sourceDisplay;
        resource.metadata.pattern = raw;
        activate(resource);
        resources.push(resource);
      }
    }
  }

  return resources;
}

function claudePromptFlag(context: ScanContext): string {
  return truthy(context.environment.OPENCODE_DISABLE_CLAUDE_CODE)
    ? "OPENCODE_DISABLE_CLAUDE_CODE"
    : "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT";
}

function claudeSkillsFlag(context: ScanContext): string {
  return truthy(context.environment.OPENCODE_DISABLE_CLAUDE_CODE)
    ? "OPENCODE_DISABLE_CLAUDE_CODE"
    : "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS";
}

async function createInstructionResource(
  filePath: string,
  context: ScanContext,
  paths: V1Paths,
  version: string,
  options: {
    scope: ResourceScope;
    origin: string;
    reach: ResourceRecord["reach"];
    disabledBy?: string;
  },
): Promise<ResourceRecord> {
  const shownPath = displayPath(filePath, context, paths.displayRoots);
  const contents = await readFile(filePath);
  return {
    id: resourceId(PROVIDER, "instruction", shownPath),
    kind: "instruction",
    provider: PROVIDER,
    providerVersion: version,
    name: path.basename(filePath),
    scope: options.scope,
    origin: options.origin,
    owner: { type: "self" },
    path: await canonicalPath(filePath),
    displayPath: shownPath,
    ...(options.reach ? { reach: options.reach } : {}),
    state: "inactive",
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${shownPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      byteLength: contents.byteLength,
      loadDirectory: path.dirname(filePath),
      ...(options.disabledBy ? { disabledBy: options.disabledBy } : {}),
    },
    findings: [],
  };
}

async function resolveInstructionGlob(
  raw: string,
  context: ScanContext,
  paths: V1Paths,
  nearestFirst: string[],
): Promise<string[]> {
  const expanded = raw.startsWith("~/") ? path.join(paths.home, raw.slice(2)) : raw;
  if (path.isAbsolute(expanded)) {
    return globFiles(path.dirname(expanded), path.basename(expanded));
  }
  const bases = paths.flags.disableProjectConfig ? [paths.configDir] : nearestFirst;
  const matches: string[] = [];
  for (const base of bases) {
    matches.push(...(await globFiles(base, expanded)));
  }
  return matches;
}

const GLOB_CHARACTERS = /[*?{[]/;

/** Minimal glob support: `*`, `?`, `**`, and `{a,b}` alternatives. */
async function globFiles(base: string, pattern: string): Promise<string[]> {
  if (!GLOB_CHARACTERS.test(pattern)) {
    const candidate = path.resolve(base, pattern);
    return (await isFile(candidate)) ? [candidate] : [];
  }
  const matcher = globToRegExp(pattern);
  const files = await walkFiles(base, (_name, candidate) =>
    matcher.test(path.relative(base, candidate).split(path.sep).join("/")),
  );
  return files;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index]!;
    if (current === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:/)?";
      }
    } else if (current === "*") {
      source += "[^/]*";
    } else if (current === "?") {
      source += "[^/]";
    } else if (current === "{") {
      braceDepth += 1;
      source += "(?:";
    } else if (current === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
    } else if (current === "," && braceDepth > 0) {
      source += "|";
    } else {
      source += current.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

interface SkillLocation {
  skillPath: string;
  scope: ResourceScope;
  origin: string;
  reach: ResourceRecord["reach"];
  disabledBy?: string;
}

async function discoverSkills(
  context: ScanContext,
  paths: V1Paths,
  version: string,
  chain: string[],
  nearestFirst: string[],
  directories: ConfigDirectory[],
  merged: Record<string, unknown>,
): Promise<ResourceRecord[]> {
  const locations: SkillLocation[] = [];
  const findings: Finding[] = [];
  const externalDisabled = paths.flags.disableExternalSkills
    ? "OPENCODE_DISABLE_EXTERNAL_SKILLS"
    : undefined;
  const externals: Array<{ directory: string; origin: string; disabledBy?: string }> = [
    {
      directory: ".claude",
      origin: "claude-compatibility",
      ...(externalDisabled
        ? { disabledBy: externalDisabled }
        : paths.flags.disableClaudeSkills
          ? { disabledBy: claudeSkillsFlag(context) }
          : {}),
    },
    {
      directory: ".agents",
      origin: "agent-compatibility",
      ...(externalDisabled ? { disabledBy: externalDisabled } : {}),
    },
  ];

  // External skill directories: global first, then every chain directory
  // nearest first. The pattern is recursive (skills/**/SKILL.md).
  for (const external of externals) {
    for (const skillPath of await findSkillFiles(path.join(paths.home, external.directory, "skills"))) {
      locations.push({
        skillPath,
        scope: "user",
        origin: external.origin,
        reach: "chain",
        ...(external.disabledBy ? { disabledBy: external.disabledBy } : {}),
      });
    }
  }
  for (const directory of nearestFirst) {
    for (const external of externals) {
      for (const skillPath of await findSkillFiles(path.join(directory, external.directory, "skills"))) {
        locations.push({
          skillPath,
          scope: "project",
          origin: external.origin,
          reach: "chain",
          ...(external.disabledBy ? { disabledBy: external.disabledBy } : {}),
        });
      }
    }
  }

  // Config directories: skill/ and skills/ under each one.
  for (const entry of directories) {
    for (const folder of ["skill", "skills"]) {
      for (const skillPath of await findSkillFiles(path.join(entry.directory, folder))) {
        locations.push({
          skillPath,
          scope: entry.scope,
          origin: "opencode-config-directory",
          reach: "chain",
          ...(entry.disabledBy ? { disabledBy: entry.disabledBy } : {}),
        });
      }
    }
  }

  // skills.paths from the merged configuration, relative to the working
  // directory.
  const skillsConfig = isRecord(merged.skills) ? merged.skills : {};
  for (const item of stringArray(skillsConfig.paths)) {
    const expanded = item.startsWith("~/") ? path.join(paths.home, item.slice(2)) : item;
    const directory = path.isAbsolute(expanded)
      ? expanded
      : path.join(context.workingDirectory, expanded);
    if (!(await isDirectory(directory))) {
      findings.push({
        code: "opencode.skill.path-missing",
        severity: "warning",
        confidence: "high",
        message: `The skills.paths entry ${item} does not exist.`,
      });
      continue;
    }
    for (const skillPath of await findSkillFiles(directory)) {
      locations.push({
        skillPath,
        scope: isWithin(context.repositoryPath, skillPath) ? "project" : "user",
        origin: "opencode-config-skill-path",
        reach: "chain",
      });
    }
  }

  // Repository copies outside the chain stay visible as inventory.
  const known = new Set(locations.map((location) => path.resolve(location.skillPath)));
  for (const skillPath of await findSkillFiles(context.repositoryPath)) {
    if (known.has(path.resolve(skillPath))) {
      continue;
    }
    const source = repositorySkillSource(skillPath);
    if (!source || chain.includes(source.scopeDirectory)) {
      continue;
    }
    locations.push({
      skillPath,
      scope: "project",
      origin: source.origin,
      reach: "repository",
    });
  }

  const resources: ResourceRecord[] = [createBuiltinSkill(version)];
  for (const location of locations) {
    resources.push(await createSkillResource(location, context, paths, version));
  }
  resolveSkillOverrides(resources);
  if (findings.length > 0) {
    const carrier = resources[0]!;
    carrier.findings = [...carrier.findings, ...findings];
  }
  return resources;
}

function repositorySkillSource(
  skillPath: string,
): { scopeDirectory: string; origin: string } | undefined {
  const resolved = path.resolve(skillPath);
  for (const source of [
    { marker: `${path.sep}.claude${path.sep}skills${path.sep}`, origin: "claude-compatibility" },
    { marker: `${path.sep}.agents${path.sep}skills${path.sep}`, origin: "agent-compatibility" },
    { marker: `${path.sep}.opencode${path.sep}skills${path.sep}`, origin: "opencode-config-directory" },
    { marker: `${path.sep}.opencode${path.sep}skill${path.sep}`, origin: "opencode-config-directory" },
  ]) {
    const index = resolved.lastIndexOf(source.marker);
    if (index >= 0) {
      return { scopeDirectory: resolved.slice(0, index) || path.sep, origin: source.origin };
    }
  }
  return undefined;
}

function createBuiltinSkill(version: string): ResourceRecord {
  const id = resourceId(PROVIDER, "skill", `builtin:${BUILTIN_SKILL_NAME}`);
  return {
    id,
    kind: "skill",
    provider: PROVIDER,
    providerVersion: version,
    name: BUILTIN_SKILL_NAME,
    scope: "bundled",
    origin: "opencode-builtin",
    owner: { type: "provider", id: PROVIDER },
    reach: "chain",
    generated: true,
    state: "active",
    precedence: {},
    evidenceType: "inferred",
    evidenceReceipt: "builtin:opencode 1.18 customize-opencode",
    capabilities: ["inspect"],
    metadata: {
      description:
        "Built-in guidance for editing OpenCode configuration. A disk skill with the same name overrides it.",
      builtin: true,
    },
    findings: [],
  };
}

function parseOpenCodeSkillFrontmatter(contents: string): {
  name?: string;
  description?: string;
  error?: string;
} {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    return { error: "SKILL.md must begin with YAML frontmatter." };
  }
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (!isRecord(parsed)) {
      return { error: "SKILL.md frontmatter must be a YAML object." };
    }
    const name = stringValue(parsed.name);
    if (!name) {
      return { error: "SKILL.md frontmatter requires a string name." };
    }
    const description = stringValue(parsed.description);
    return { name, ...(description ? { description } : {}) };
  } catch {
    return { error: "SKILL.md frontmatter is not valid YAML." };
  }
}

async function createSkillResource(
  location: SkillLocation,
  context: ScanContext,
  paths: V1Paths,
  version: string,
): Promise<ResourceRecord> {
  const contents = await readFile(location.skillPath, "utf8");
  const parsed = parseOpenCodeSkillFrontmatter(contents);
  const shownPath = displayPath(location.skillPath, context, paths.displayRoots);
  const id = resourceId(PROVIDER, "skill", shownPath);
  const findings: Finding[] = [];
  const missingDescription = !parsed.error && !parsed.description;
  if (parsed.error) {
    findings.push({
      code: "opencode.skill.invalid-frontmatter",
      severity: "error",
      confidence: "high",
      message: parsed.error,
      resourceId: id,
    });
  } else if (missingDescription) {
    findings.push({
      code: "opencode.skill.missing-description",
      severity: "warning",
      confidence: "high",
      message: "The skill has no description, so OpenCode never surfaces it to agents.",
      resourceId: id,
    });
  }
  const state: ResourceRecord["state"] = parsed.error
    ? "invalid"
    : location.disabledBy
      ? "disabled"
      : location.reach === "repository" || missingDescription
        ? "inactive"
        : "active";

  return {
    id,
    kind: "skill",
    provider: PROVIDER,
    providerVersion: version,
    name: parsed.name ?? path.basename(path.dirname(location.skillPath)),
    scope: location.scope,
    origin: location.origin,
    owner: { type: "self" },
    path: await canonicalPath(location.skillPath),
    displayPath: shownPath,
    ...(location.reach ? { reach: location.reach } : {}),
    state,
    precedence: {},
    evidenceType: "parsed",
    evidenceReceipt: `file:${shownPath}`,
    capabilities: ["inspect", "open"],
    metadata: {
      description: parsed.description ?? "",
      ...(missingDescription ? { missingDescription: true } : {}),
      ...(location.disabledBy ? { disabledBy: location.disabledBy } : {}),
    },
    findings,
  };
}

/**
 * OpenCode keys skills by name and keeps the last one it loads, warning about
 * the duplicate. Disk discovery order is the order used here; the binary loads
 * matches concurrently, so the duplicate itself is the actionable problem.
 */
function resolveSkillOverrides(resources: ResourceRecord[]): void {
  const groups = new Map<string, ResourceRecord[]>();
  for (const resource of resources) {
    if (
      resource.state === "invalid" ||
      resource.state === "disabled" ||
      resource.reach === "repository"
    ) {
      continue;
    }
    const group = groups.get(resource.name) ?? [];
    group.push(resource);
    groups.set(resource.name, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const winner = group[group.length - 1]!;
    for (const loser of group.slice(0, -1)) {
      loser.state = "shadowed";
      loser.precedence = { shadowedBy: winner.id };
      if (loser.origin === "opencode-builtin") {
        continue;
      }
      loser.findings.push({
        code: "opencode.skill.duplicate-name",
        severity: "warning",
        confidence: "medium",
        message: `Skill name ${loser.name} is defined more than once; OpenCode keeps the last copy it loads.`,
        resourceId: loser.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

interface PluginCandidate {
  resource: ResourceRecord;
  identity: string;
}

async function discoverPlugins(
  context: ScanContext,
  paths: V1Paths,
  version: string,
  sources: ConfigSource[],
  directories: ConfigDirectory[],
): Promise<ResourceRecord[]> {
  const candidates: PluginCandidate[] = [];
  const fileSources = sources.filter((source) => source.phase === "file");
  const directoryConfigs = sources.filter((source) => source.phase === "directory");

  const fromSource = async (source: ConfigSource): Promise<void> => {
    for (const entry of Array.isArray(source.config.plugin) ? source.config.plugin : []) {
      const specifier = Array.isArray(entry) ? stringValue(entry[0]) : stringValue(entry);
      if (!specifier) {
        continue;
      }
      candidates.push(await createConfiguredPlugin(specifier, source, context, paths, version));
    }
  };

  // Global files, OPENCODE_CONFIG, and project files first...
  for (const source of fileSources) {
    await fromSource(source);
  }
  // ...then each config directory: its own config files, then the files in
  // its plugin/ or plugins/ folder.
  for (const entry of directories) {
    for (const source of directoryConfigs.filter(
      (candidate) => path.dirname(candidate.filePath) === entry.directory,
    )) {
      await fromSource(source);
    }
    for (const folder of ["plugin", "plugins"]) {
      const root = path.join(entry.directory, folder);
      const files = await walkFiles(
        root,
        (name, candidate) =>
          path.dirname(candidate) === root && /\.(?:ts|js)$/.test(name),
      );
      for (const filePath of files) {
        candidates.push(await createDirectoryPlugin(filePath, entry, context, paths, version));
      }
    }
  }

  // OpenCode dedupes on package name or file URL and keeps the last one.
  const lastIndex = new Map<string, number>();
  candidates.forEach((candidate, index) => lastIndex.set(candidate.identity, index));
  candidates.forEach((candidate, index) => {
    const winnerIndex = lastIndex.get(candidate.identity);
    if (winnerIndex !== undefined && winnerIndex !== index) {
      const winner = candidates[winnerIndex]!.resource;
      if (candidate.resource.state === "active") {
        candidate.resource.state = "shadowed";
      }
      candidate.resource.precedence = { ...candidate.resource.precedence, shadowedBy: winner.id };
    }
  });

  return candidates.map((candidate) => candidate.resource);
}

function isPathPluginSpec(specifier: string): boolean {
  return (
    specifier.startsWith("file://") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("~/") ||
    path.isAbsolute(specifier)
  );
}

function npmPackageName(specifier: string): string {
  const scoped = specifier.startsWith("@");
  const body = scoped ? specifier.slice(1) : specifier;
  const at = body.indexOf("@");
  const name = at === -1 ? body : body.slice(0, at);
  return scoped ? `@${name}` : name;
}

async function createConfiguredPlugin(
  specifier: string,
  source: ConfigSource,
  context: ScanContext,
  paths: V1Paths,
  version: string,
): Promise<PluginCandidate> {
  const sourceDisplay = displayPath(source.filePath, context, paths.displayRoots);
  const disabledBy = source.disabledBy;
  if (isPathPluginSpec(specifier)) {
    const filePath = specifier.startsWith("file://")
      ? new URL(specifier).pathname
      : specifier.startsWith("~/")
        ? path.join(paths.home, specifier.slice(2))
        : path.resolve(path.dirname(source.filePath), specifier);
    const exists = await isFile(filePath);
    const shownPath = displayPath(filePath, context, paths.displayRoots);
    const id = resourceId(PROVIDER, "plugin", `${sourceDisplay}:${specifier}`);
    return {
      identity: `file:${await canonicalPath(filePath)}`,
      resource: {
        id,
        kind: "plugin",
        provider: PROVIDER,
        providerVersion: version,
        name: path.basename(filePath),
        scope: source.scope,
        origin: "opencode-config",
        owner: { type: "self" },
        ...(exists ? { path: await canonicalPath(filePath) } : {}),
        displayPath: shownPath,
        reach: "chain",
        state: disabledBy ? "disabled" : exists ? "active" : "unavailable",
        precedence: { configOrder: source.order },
        evidenceType: "parsed",
        evidenceReceipt: `file:${sourceDisplay}`,
        capabilities: exists ? ["inspect", "open"] : ["inspect"],
        metadata: {
          specifier,
          sourceType: "file",
          configSource: sourceDisplay,
          ...(disabledBy ? { disabledBy } : {}),
        },
        findings: exists
          ? []
          : [
              {
                code: "opencode.plugin.missing-reference",
                severity: "warning",
                confidence: "high",
                message: `The plugin entry ${specifier} in ${sourceDisplay} does not exist.`,
                resourceId: id,
              },
            ],
      },
    };
  }

  const packageName = npmPackageName(specifier);
  const installed = await isDirectory(
    path.join(paths.cacheDir, "node_modules", ...packageName.split("/")),
  );
  const id = resourceId(PROVIDER, "plugin", `${sourceDisplay}:${specifier}`);
  return {
    identity: `npm:${packageName}`,
    resource: {
      id,
      kind: "plugin",
      provider: PROVIDER,
      providerVersion: version,
      name: packageName,
      scope: source.scope,
      origin: "opencode-config",
      owner: { type: "package", id: packageName },
      path: await canonicalPath(source.filePath),
      displayPath: sourceDisplay,
      reach: "chain",
      state: disabledBy ? "disabled" : "active",
      precedence: { configOrder: source.order },
      evidenceType: "parsed",
      evidenceReceipt: `file:${sourceDisplay}`,
      capabilities: ["inspect"],
      metadata: {
        specifier,
        sourceType: "npm",
        installed,
        configSource: sourceDisplay,
        ...(disabledBy ? { disabledBy } : {}),
      },
      findings: [],
    },
  };
}

async function createDirectoryPlugin(
  filePath: string,
  entry: ConfigDirectory,
  context: ScanContext,
  paths: V1Paths,
  version: string,
): Promise<PluginCandidate> {
  const shownPath = displayPath(filePath, context, paths.displayRoots);
  return {
    identity: `file:${await canonicalPath(filePath)}`,
    resource: {
      id: resourceId(PROVIDER, "plugin", shownPath),
      kind: "plugin",
      provider: PROVIDER,
      providerVersion: version,
      name: path.basename(filePath),
      scope: entry.scope,
      origin: "opencode-plugin-directory",
      owner: { type: "self" },
      path: await canonicalPath(filePath),
      displayPath: shownPath,
      reach: "chain",
      state: entry.disabledBy ? "disabled" : "active",
      precedence: {},
      evidenceType: "parsed",
      evidenceReceipt: `file:${shownPath}`,
      capabilities: ["inspect", "open"],
      metadata: {
        sourceType: "file",
        ...(entry.disabledBy ? { disabledBy: entry.disabledBy } : {}),
      },
      findings: [],
    },
  };
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

async function discoverMcpServers(
  context: ScanContext,
  paths: V1Paths,
  version: string,
  sources: ConfigSource[],
): Promise<ResourceRecord[]> {
  const resources: ResourceRecord[] = [];
  const merged = new Map<string, Record<string, unknown>>();
  const winners = new Map<string, ResourceRecord>();

  for (const source of sources) {
    const servers = isRecord(source.config.mcp) ? source.config.mcp : {};
    const sourceDisplay = displayPath(source.filePath, context, paths.displayRoots);
    for (const [name, rawServer] of Object.entries(servers)) {
      if (!isRecord(rawServer)) {
        continue;
      }
      const resource: ResourceRecord = {
        id: resourceId(PROVIDER, "mcp", `${sourceDisplay}:${name}`),
        kind: "mcp",
        provider: PROVIDER,
        providerVersion: version,
        name,
        scope: source.scope,
        origin: "opencode-config",
        owner: { type: "self" },
        path: await canonicalPath(source.filePath),
        displayPath: sourceDisplay,
        reach: "chain",
        state: source.disabledBy ? "disabled" : "active",
        precedence: { configOrder: source.order },
        evidenceType: "parsed",
        evidenceReceipt: `file:${sourceDisplay}`,
        capabilities: ["inspect"],
        metadata: {
          ...sanitizeOpenCodeMcp(rawServer),
          ...(source.disabledBy ? { disabledBy: source.disabledBy } : {}),
        },
        findings: [],
      };
      resources.push(resource);
      if (source.disabledBy) {
        continue;
      }
      const previous = winners.get(name);
      if (previous) {
        previous.state = "shadowed";
        previous.precedence = { ...previous.precedence, shadowedBy: resource.id };
      }
      // OpenCode deep-merges configuration, so fields from every source stay
      // in force unless a later source overrides them.
      merged.set(name, { ...(merged.get(name) ?? {}), ...rawServer });
      winners.set(name, resource);
    }
  }

  for (const [name, winner] of winners) {
    const configured = merged.get(name) ?? {};
    winner.metadata = {
      ...winner.metadata,
      ...sanitizeOpenCodeMcp(configured),
      enabled: configured.enabled !== false,
    };
    if (configured.enabled === false) {
      winner.state = "disabled";
    }
  }

  return resources;
}

function compareResources(left: ResourceRecord, right: ResourceRecord): number {
  return `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
    `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
  );
}
