import path from "node:path";

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
} from "../core/schema.ts";
import { SCHEMA_VERSION } from "../core/schema.ts";
import {
  discoverV1,
  explainV1,
  openCodeV1Paths,
  resolveEffectiveV1,
} from "./opencode-v1.ts";
import { discoverV2, explainV2, resolveEffectiveV2 } from "./opencode-v2.ts";
import { isDirectory, parseSemanticVersion, runCommand } from "./shared.ts";

/**
 * Version dispatch for OpenCode.
 *
 * - 1.18.x is supported by the v1 module, which follows the released 1.18.30
 *   configuration, instruction, skill, plugin, and MCP rules.
 * - 2.x rules live in the isolated v2 module. They are documented but not
 *   verified against a released binary, so 2.x is reported as unsupported
 *   and its rules are never applied to a real installation.
 */
export class OpenCodeAdapter implements ProviderAdapter {
  readonly provider = "opencode" as const;
  readonly capabilities: AdapterCapabilities = {
    resourceKinds: ["instruction", "skill", "plugin", "mcp"],
    nativeInspection: false,
  };

  async detect(context: ScanContext): Promise<ProviderDetection> {
    const executablePath = context.executables?.opencode ?? "opencode";
    const result = await runCommand(executablePath, ["--version"], context, 2_000);
    const version = parseSemanticVersion(result.stdout);
    const installed = result.status === 0;
    const [major, minor] = version === "unknown"
      ? [undefined, undefined]
      : version.split(".").map(Number);
    const generation =
      major === undefined
        ? "unknown"
        : major === 1
          ? "v1"
          : major === 2
            ? "v2"
            : major < 1
              ? "legacy"
              : "future";
    const paths = openCodeV1Paths(context);
    const projectRoot = path.join(context.repositoryPath, ".opencode");
    const configRoots = [paths.configDir];
    if (await isDirectory(projectRoot)) {
      configRoots.push(projectRoot);
    }
    const supported = installed && generation === "v1" && minor === 18;
    const supportNote = !installed || supported
      ? undefined
      : generation === "v2"
        ? "OpenCode 2.x rules are documented but not verified against a released binary, so they are not applied."
        : generation === "v1"
          ? "Only OpenCode 1.18.x is verified."
          : undefined;

    return {
      provider: this.provider,
      installed,
      version,
      support: !installed ? "unavailable" : supported ? "supported" : "unsupported",
      generation,
      ...(supportNote ? { supportNote } : {}),
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
    if (detection.generation === "v2") {
      return discoverV2(context, detection);
    }
    return discoverV1(context, detection);
  }

  async resolveEffective(
    context: ScanContext,
    resources: ResourceRecord[],
    detection: ProviderDetection,
  ): Promise<EffectiveConfiguration> {
    if (detection.generation === "v2") {
      return resolveEffectiveV2(context, resources, detection);
    }
    if (detection.support !== "supported") {
      return {
        schemaVersion: SCHEMA_VERSION,
        provider: this.provider,
        providerVersion: detection.version,
        repositoryPath: context.repositoryPath,
        workingDirectory: context.workingDirectory,
        orderedResourceIds: [],
        resources: [],
        decisions: [],
      };
    }
    return resolveEffectiveV1(context, resources, detection);
  }

  async validate(
    _context: ScanContext,
    resources: ResourceRecord[],
  ): Promise<Finding[]> {
    return resources.flatMap((resource) => resource.findings);
  }

  explain(resource: ResourceRecord): string {
    return resource.providerVersion.startsWith("2.")
      ? explainV2(resource)
      : explainV1(resource);
  }
}
