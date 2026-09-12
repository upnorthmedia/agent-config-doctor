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

export type ResourceReach = "chain" | "repository";

/**
 * How a provider brings a resource into a session: instructions are loaded
 * into context, skills are available on demand, and plugins or MCP servers
 * must be explicitly enabled.
 */
export type ResourceLoadMode =
  | "context-loaded"
  | "on-demand"
  | "explicitly-enabled";

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
  /**
   * Set to `repository` when the finding belongs to a resource found outside
   * the selected directory's ancestor chain. Such findings keep their true
   * severity but are left out of every default total.
   */
  reach?: ResourceReach;
}

/**
 * An operational notice about the scan itself, such as a native inspection
 * command that timed out. Notices describe scan completeness; they are never
 * findings against the user's configuration and never count as errors.
 */
export interface ScanNotice {
  code: string;
  provider: ProviderId;
  command: string;
  message: string;
  remediation: string;
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
  reach?: ResourceReach;
  loadMode?: ResourceLoadMode;
  /** True for caches and provider runtime copies that the user does not author. */
  generated?: boolean;
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
  notices: ScanNotice[];
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
    complete: boolean;
  };
  resources: PublicResourceRecord[];
  effective: {
    orderedResourceIds: string[];
    decisions: EffectiveResource[];
  };
  findings: Finding[];
  notices: ScanNotice[];
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
  notices: ScanNotice[];
}
