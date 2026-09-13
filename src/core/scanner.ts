import { SCHEMA_VERSION } from "./schema.ts";
import path from "node:path";

import type { ProviderAdapter, ScanContext } from "./provider-adapter.ts";
import { describeFindings } from "./rules.ts";
import type {
  EffectiveConfiguration,
  EffectiveResource,
  Finding,
  JsonValue,
  PublicResourceRecord,
  ResourceKind,
  ResourceLoadMode,
  ResourceRecord,
  ScanReport,
  ScanSnapshot,
} from "./schema.ts";

export async function scanProvider(
  adapter: ProviderAdapter,
  context: ScanContext,
): Promise<ScanSnapshot> {
  const detection = await adapter.detect(context);
  const discovery = await adapter.discover(context, detection);
  const effective = normalizeEffective(
    await adapter.resolveEffective(context, discovery.resources, detection),
  );
  const findings = describeFindings(
    [
      ...detectionFindings(detection),
      ...scopeFindings(
        await adapter.validate(context, effective.resources),
        effective.resources,
      ),
    ],
    effective.resources,
  );

  return {
    detection,
    effective: {
      ...effective,
      resources: effective.resources.map((resource) => ({
        ...resource,
        findings: describeFindings(resource.findings, effective.resources),
      })),
    },
    findings,
    notices: discovery.notices,
  };
}

const defaultLoadModes: Partial<Record<ResourceKind, ResourceLoadMode>> = {
  instruction: "context-loaded",
  skill: "on-demand",
  plugin: "explicitly-enabled",
  mcp: "explicitly-enabled",
};

/**
 * Fills the optional classification fields every adapter shares and scopes
 * the effective configuration to the selected directory's real ancestor
 * chain. Resources discovered elsewhere in the repository stay in inventory
 * with `reach: "repository"`, but they never become active and they are not
 * part of the ordered chain or the effective decisions.
 */
function normalizeEffective(
  effective: EffectiveConfiguration,
): EffectiveConfiguration {
  const resources = dedupeResources(effective.resources).map((resource) => {
    const reach = resource.reach ?? "chain";
    const loadMode = resource.loadMode ?? defaultLoadModes[resource.kind];
    return {
      ...resource,
      reach,
      ...(loadMode ? { loadMode } : {}),
      state:
        reach === "repository" && resource.state === "active"
          ? ("inactive" as const)
          : resource.state,
      findings:
        reach === "repository"
          ? resource.findings.map(offChainFinding)
          : resource.findings,
    };
  });
  const offChain = new Set(
    resources
      .filter((resource) => resource.reach === "repository")
      .map((resource) => resource.id),
  );

  const seenOrdered = new Set<string>();
  const seenDecisions = new Set<string>();

  return {
    ...effective,
    resources,
    orderedResourceIds: effective.orderedResourceIds.filter((id) => {
      if (offChain.has(id) || seenOrdered.has(id)) {
        return false;
      }
      seenOrdered.add(id);
      return true;
    }),
    decisions: preferActive(effective.decisions).filter((decision) => {
      if (offChain.has(decision.resourceId) || seenDecisions.has(decision.resourceId)) {
        return false;
      }
      seenDecisions.add(decision.resourceId);
      return true;
    }),
  };
}

/**
 * An opaque ID must name exactly one record. The same file can be discovered
 * twice when a provider home lives inside the scanned repository (once from
 * the home, once from the repository walk); keep the copy that is in the
 * ancestor chain, then the active one, then the first seen.
 */
function dedupeResources(resources: ResourceRecord[]): ResourceRecord[] {
  const byId = new Map<string, ResourceRecord>();
  for (const resource of resources) {
    const existing = byId.get(resource.id);
    if (!existing || rank(resource) > rank(existing)) {
      byId.set(resource.id, resource);
    }
  }
  return resources.filter((resource) => byId.get(resource.id) === resource);
}

function rank(resource: ResourceRecord): number {
  return (
    (resource.reach !== "repository" ? 2 : 0) +
    (resource.state === "active" ? 1 : 0)
  );
}

/** Orders decisions so that an active decision for an ID wins the dedupe. */
function preferActive(decisions: EffectiveResource[]): EffectiveResource[] {
  return [...decisions].sort(
    (left, right) =>
      Number(right.state === "active") - Number(left.state === "active"),
  );
}

/**
 * Findings mirror the reach of the resource they belong to. A finding on an
 * off-chain resource keeps its severity (a broken import is still broken in
 * that file) but carries `reach: "repository"` so default totals can skip it.
 */
function scopeFindings(
  findings: Finding[],
  resources: ResourceRecord[],
): Finding[] {
  const offChain = new Set(
    resources
      .filter((resource) => resource.reach === "repository")
      .map((resource) => resource.id),
  );
  return findings.map((finding) =>
    finding.resourceId && offChain.has(finding.resourceId)
      ? offChainFinding(finding)
      : finding,
  );
}

function offChainFinding(finding: Finding): Finding {
  return { ...finding, reach: "repository" };
}

export function isInContext(finding: Pick<Finding, "reach">): boolean {
  return finding.reach !== "repository";
}

function detectionFindings(
  detection: ScanSnapshot["detection"],
): ScanSnapshot["findings"] {
  if (detection.support === "unsupported") {
    return [
      {
        code: "provider.version.unsupported",
        severity: "warning",
        confidence: "high",
        message: `The installed ${detection.provider} version (${detection.version}) is not supported by this adapter.${detection.supportNote ? ` ${detection.supportNote}` : ""}`,
      },
    ];
  }
  if (detection.support === "unavailable") {
    return [
      {
        code: "provider.executable.unavailable",
        severity: "warning",
        confidence: "high",
        message: `The ${detection.provider} executable could not be invoked.`,
      },
    ];
  }
  return [];
}

export function createScanReport(
  snapshot: ScanSnapshot,
  context: ScanContext,
): ScanReport {
  const resources = snapshot.effective.resources
    .map(toPublicResource)
    .sort((left, right) =>
      `${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
        `${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
      ),
    );
  const resourceOrder = new Map(
    resources.map((resource, index) => [resource.id, index]),
  );

  const report: ScanReport = {
    schemaVersion: SCHEMA_VERSION,
    subject: {
      repository: "$REPO",
      workingDirectory: redactPath(context.workingDirectory, context),
    },
    detection: {
      provider: snapshot.detection.provider,
      installed: snapshot.detection.installed,
      version: snapshot.detection.version,
      support: snapshot.detection.support,
      ...(snapshot.detection.generation
        ? { generation: snapshot.detection.generation }
        : {}),
      configRoots: snapshot.detection.configRoots.map((root) =>
        redactPath(root, context),
      ),
      complete: snapshot.notices.length === 0,
    },
    resources,
    effective: {
      orderedResourceIds: [...snapshot.effective.orderedResourceIds],
      decisions: [...snapshot.effective.decisions].sort(
        (left, right) =>
          (resourceOrder.get(left.resourceId) ?? Number.MAX_SAFE_INTEGER) -
          (resourceOrder.get(right.resourceId) ?? Number.MAX_SAFE_INTEGER),
      ),
    },
    findings: [...snapshot.findings].sort((left, right) =>
      `${left.code}:${left.resourceId ?? ""}:${left.message}`.localeCompare(
        `${right.code}:${right.resourceId ?? ""}:${right.message}`,
      ),
    ),
    notices: [...snapshot.notices].sort((left, right) =>
      `${left.code}:${left.command}`.localeCompare(`${right.code}:${right.command}`),
    ),
  };

  return redactPublicPaths(report, context);
}

export function serializeScanReport(report: ScanReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function toPublicResource(resource: ScanSnapshot["effective"]["resources"][number]): PublicResourceRecord {
  const { path: _privatePath, ...publicResource } = resource;
  return {
    ...publicResource,
    precedence: redactMetadata(resource.precedence),
    metadata: redactMetadata(resource.metadata),
  };
}

function redactMetadata(
  metadata: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const privateKeys = new Set([
    "canonicalTarget",
    "discoveredDirectory",
    "discoveredPath",
    "loadDirectory",
  ]);

  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !privateKeys.has(key)),
  );
}

function redactPublicPaths<T>(value: T, context: ScanContext): T {
  if (typeof value === "string") {
    return redactKnownRoots(value, context) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPublicPaths(item, context)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactPublicPaths(item, context),
      ]),
    ) as T;
  }
  return value;
}

function redactKnownRoots(value: string, context: ScanContext): string {
  const roots = [
    [
      "$CODEX_HOME",
      path.resolve(
        context.environment.CODEX_HOME ??
          path.join(context.homeDirectory, ".codex"),
      ),
    ],
    ["$REPO", path.resolve(context.repositoryPath)],
    ["$HOME", path.resolve(context.homeDirectory)],
  ] as const;

  let redacted = value;
  for (const [label, root] of roots) {
    const variants = new Set([root, root.split(path.sep).join("/")]);
    for (const variant of variants) {
      if (variant.length > path.parse(variant).root.length) {
        redacted = redacted.split(variant).join(label);
      }
    }
  }
  return redacted;
}

function redactPath(candidate: string, context: ScanContext): string {
  const codexHome = path.resolve(
    context.environment.CODEX_HOME ?? path.join(context.homeDirectory, ".codex"),
  );

  for (const [label, root] of [
    ["$CODEX_HOME", codexHome],
    ["$REPO", path.resolve(context.repositoryPath)],
    ["$HOME", path.resolve(context.homeDirectory)],
  ] as const) {
    const relativePath = path.relative(root, path.resolve(candidate));
    if (
      relativePath === "" ||
      (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`))
    ) {
      const normalized = relativePath.split(path.sep).join("/");
      return normalized ? `${label}/${normalized}` : label;
    }
  }

  return `<external>/${path.basename(candidate)}`;
}
