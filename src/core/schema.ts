export const SCHEMA_VERSION = 1 as const;

export type ProviderId = "claude" | "codex" | "grok" | "opencode" | "hermes";

export type ResourceKind =
  | "instruction"
  | "skill"
  | "plugin"
  | "mcp"
  | "hook"
  | "agent";

export type ResourceScope =
  | "managed"
  | "user"
  | "project"
  | "local"
  | "session"
  | "bundled";

export type ResourceState =
  | "active"
  | "inactive"
  | "shadowed"
  | "disabled"
  | "blocked"
  | "invalid"
  | "unavailable";

export type EvidenceType = "native" | "parsed" | "inferred";
export type FindingSeverity = "info" | "warning" | "error";
export type FindingConfidence = "low" | "medium" | "high";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ResourceOwner {
  type: "self" | "plugin" | "package" | "provider" | "administrator";
  id?: string;
}

export interface Finding {
  code: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  message: string;
  resourceId?: string;
}

export interface ResourceRecord {
  id: string;
  kind: ResourceKind;
  provider: ProviderId;
  providerVersion: string;
  name: string;
  scope: ResourceScope;
  origin: string;
  owner: ResourceOwner;
  path?: string;
  displayPath?: string;
  state: ResourceState;
  precedence: Record<string, JsonValue>;
  evidenceType: EvidenceType;
  evidenceReceipt: string;
  capabilities: string[];
  metadata: Record<string, JsonValue>;
  findings: Finding[];
}

export interface EffectiveResource {
  resourceId: string;
  state: ResourceState;
  order?: number;
  reason: string;
}

export interface EffectiveConfiguration {
  schemaVersion: typeof SCHEMA_VERSION;
  provider: ProviderId;
  providerVersion: string;
  repositoryPath: string;
  workingDirectory: string;
  orderedResourceIds: string[];
  resources: ResourceRecord[];
  decisions: EffectiveResource[];
}

export interface ScanSnapshot {
  detection: import("./provider-adapter.ts").ProviderDetection;
  effective: EffectiveConfiguration;
  findings: Finding[];
}

export type PublicResourceRecord = Omit<ResourceRecord, "path">;

export interface ScanReport {
  schemaVersion: typeof SCHEMA_VERSION;
  subject: {
    repository: string;
    workingDirectory: string;
  };
  detection: {
    provider: ProviderId;
    installed: boolean;
    version: string;
    support: import("./provider-adapter.ts").ProviderDetection["support"];
    generation?: string;
    configRoots: string[];
  };
  resources: PublicResourceRecord[];
  effective: {
    orderedResourceIds: string[];
    decisions: EffectiveResource[];
  };
  findings: Finding[];
}

export interface AggregateFinding extends Finding {
  provider: ProviderId;
}

export interface AggregateScanReport {
  schemaVersion: typeof SCHEMA_VERSION;
  subject: ScanReport["subject"];
  providers: ScanReport["detection"][];
  resources: PublicResourceRecord[];
  effective: Record<
    ProviderId,
    {
      providerVersion: string;
      orderedResourceIds: string[];
      decisions: EffectiveResource[];
    }
  >;
  findings: AggregateFinding[];
}
