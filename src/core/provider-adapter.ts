import type {
  EffectiveConfiguration,
  Finding,
  ProviderId,
  ResourceKind,
  ResourceRecord,
  ScanNotice,
} from "./schema.ts";

export interface ScanContext {
  homeDirectory: string;
  repositoryPath: string;
  workingDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  executables?: Readonly<Partial<Record<ProviderId, string>>>;
  adminRoots?: Readonly<Partial<Record<ProviderId, string>>>;
  /** Budget for one native inspection command. Defaults to 15 seconds. */
  nativeCommandTimeoutMs?: number;
}

export interface DiscoveryResult {
  resources: ResourceRecord[];
  /** Operational notices, such as a native listing that could not be used. */
  notices: ScanNotice[];
}

export interface ProviderDetection {
  provider: ProviderId;
  installed: boolean;
  version: string;
  support: "supported" | "unsupported" | "unavailable";
  generation?: string;
  /** Extra context for an unsupported version, appended to its finding. */
  supportNote?: string;
  executablePath?: string;
  configRoots: string[];
}

export interface AdapterCapabilities {
  resourceKinds: ResourceKind[];
  nativeInspection: boolean;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly capabilities: AdapterCapabilities;

  detect(context: ScanContext): Promise<ProviderDetection>;
  discover(
    context: ScanContext,
    detection: ProviderDetection,
  ): Promise<DiscoveryResult>;
  resolveEffective(
    context: ScanContext,
    resources: ResourceRecord[],
    detection: ProviderDetection,
  ): Promise<EffectiveConfiguration>;
  validate(
    context: ScanContext,
    resources: ResourceRecord[],
  ): Promise<Finding[]>;
  explain(resource: ResourceRecord): string;
}
