import { SCHEMA_VERSION } from "./schema.ts";
import path from "node:path";

import type { ProviderAdapter, ScanContext } from "./provider-adapter.ts";
import type {
  EffectiveConfiguration,
  JsonValue,
  PublicResourceRecord,
  ScanReport,
  ScanSnapshot,
} from "./schema.ts";

export async function scanProvider(
  adapter: ProviderAdapter,
  context: ScanContext,
): Promise<ScanSnapshot> {
  const detection = await adapter.detect(context);
  const discovery = await adapter.discover(context, detection);
  const effective = scopeToAncestorChain(
    await adapter.resolveEffective(context, discovery.resources, detection),
  );
  const findings = [
    ...detectionFindings(detection),
    ...(await adapter.validate(context, effective.resources)),
  ];

  return {
    detection,
    effective,
    findings,
    notices: discovery.notices,
  };
}

/**
 * Effective configuration is built only from the selected directory's real
 * ancestor chain. Resources discovered elsewhere in the repository stay in
 * inventory with `reach: "repository"`, but they never become active and they
 * are not part of the ordered chain or the effective decisions.
 */
function scopeToAncestorChain(
  effective: EffectiveConfiguration,
): EffectiveConfiguration {
  const resources = effective.resources.map((resource) => {
    const reach = resource.reach ?? "chain";
    return {
      ...resource,
      reach,
      state:
        reach === "repository" && resource.state === "active"
          ? ("inactive" as const)
          : resource.state,
    };
  });
  const offChain = new Set(
    resources
      .filter((resource) => resource.reach === "repository")
      .map((resource) => resource.id),
  );

  return {
    ...effective,
    resources,
    orderedResourceIds: effective.orderedResourceIds.filter(
      (id) => !offChain.has(id),
    ),
    decisions: effective.decisions.filter(
      (decision) => !offChain.has(decision.resourceId),
    ),
  };
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
        message: `The installed ${detection.provider} version (${detection.version}) is not supported by this adapter.`,
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
