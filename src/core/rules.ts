import { providerLabel } from "../providers/shared.ts";
import type { Finding, FindingOwner, ResourceRecord } from "./schema.ts";

/**
 * The rule catalog turns an internal finding code into operator language:
 * what went wrong, what it changes, who controls the file, and what to do.
 * Codes and raw messages stay on the finding as technical detail.
 */
interface RuleContext {
  finding: Finding;
  resource: ResourceRecord | undefined;
  provider: string;
}

interface RuleDefinition {
  title: string | ((context: RuleContext) => string);
  impact: string | ((context: RuleContext) => string);
  /** What the controlling user does about it. */
  remediation: string;
  /** Evidence shown to the operator; defaults to the raw message. */
  evidence?: (context: RuleContext) => string;
}

const invalidSkillFrontmatter: RuleDefinition = {
  title: "Skill metadata cannot be parsed",
  impact: ({ provider }) =>
    `${provider} cannot load this skill until the frontmatter at the top of SKILL.md is valid.`,
  remediation: "Correct the YAML frontmatter at the top of SKILL.md.",
};

const rules: Record<string, RuleDefinition> = {
  "claude.instruction.broken-import": {
    title: "An imported instruction file is missing",
    impact:
      "Claude Code skips the missing import, so the instructions it points at never load.",
    remediation: "Fix the @ import path or restore the missing file.",
  },
  "claude.skill.invalid-frontmatter": invalidSkillFrontmatter,
  "codex.skill.invalid-frontmatter": invalidSkillFrontmatter,
  "grok.skill.invalid-frontmatter": invalidSkillFrontmatter,
  "hermes.skill.invalid-frontmatter": invalidSkillFrontmatter,
  "opencode.skill.invalid-frontmatter": invalidSkillFrontmatter,
  "codex.skill.name-directory-mismatch": {
    title: ({ resource }) =>
      sameIgnoringCase(resource?.name, skillDirectoryName(resource))
        ? "Skill folder and metadata use different capitalization"
        : "Skill folder and metadata use different names",
    impact: ({ resource, provider }) =>
      isUserControlled(resource)
        ? "The skill still loads, but the name Codex shows differs from the folder you see on disk."
        : `No impact detected. ${provider} manages this ${resource?.generated ? "bundled " : ""}skill.`,
    remediation: "Rename the folder or change the name field so they match.",
    evidence: ({ resource, finding }) =>
      resource?.displayPath
        ? `${resource.name} in ${lastSegments(resource.displayPath, 2)}`
        : finding.message,
  },
  "grok.instruction.multiple-loaded": {
    title: "Several instruction files load from one directory",
    impact:
      "Grok Build loads every one of them, so the instructions can repeat or conflict.",
    remediation: "Keep one instruction file per directory.",
  },
  "hermes.plugin.invalid-manifest": {
    title: "Plugin manifest is not valid YAML",
    impact: "Hermes cannot load the plugin.",
    remediation: "Fix the YAML in the plugin manifest.",
  },
  "hermes.plugin.project-trust-blocked": {
    title: "Project plugin is blocked until project plugins are enabled",
    impact: "Hermes ignores this plugin in the project.",
    remediation:
      "Enable project plugin discovery in Hermes if you trust this project.",
  },
  "hermes.plugin.missing-environment": {
    title: "Plugin needs environment variables that are not set",
    impact: "Hermes blocks the plugin until every required variable is set.",
    remediation:
      "Set the environment variables the plugin manifest requires, then restart Hermes.",
  },
  "opencode.instruction.missing-reference": {
    title: "An instructions entry matches no file",
    impact: "OpenCode loads nothing for that entry.",
    remediation:
      "Fix the path or glob in the instructions setting, or remove the entry.",
  },
  "opencode.skill.path-missing": {
    title: "A skills.paths entry does not exist",
    impact: "OpenCode finds no skills in that location.",
    remediation: "Create the directory or remove the skills.paths entry.",
  },
  "opencode.skill.missing-description": {
    title: "Skill has no description",
    impact: "OpenCode never surfaces the skill to agents.",
    remediation: "Add a description to the SKILL.md frontmatter.",
  },
  "opencode.skill.duplicate-name": {
    title: "Skill name is defined more than once",
    impact:
      "Only one copy is available. OpenCode keeps the last copy it loads, so which one wins is not certain.",
    remediation: "Rename or remove one of the copies.",
  },
  "opencode.plugin.missing-reference": {
    title: "A plugin entry does not exist",
    impact: "OpenCode cannot load the plugin.",
    remediation: "Fix the plugin path or remove the entry.",
  },
  "provider.version.unsupported": {
    title: "Installed provider version is not supported",
    impact:
      "The provider was detected, but its configuration was not scanned because these rules are version-specific.",
    remediation:
      "Use a supported version, or wait for a release of Agent Config Doctor that supports this one.",
  },
  "provider.executable.unavailable": {
    title: "Provider executable could not be run",
    impact: "No configuration was scanned for this provider.",
    remediation:
      "Confirm the provider executable is on PATH and runs, then rerun the scan.",
  },
};

export function describeFinding(
  finding: Finding,
  resource: ResourceRecord | undefined,
): Finding {
  const providerId = resource?.provider ?? providerFromCode(finding.code);
  const provider = providerId ? providerLabel(providerId) : "The provider";
  const context: RuleContext = { finding, resource, provider };
  const rule = rules[finding.code];
  const owner: FindingOwner = resource?.owner.type ?? "provider";
  const userControlled = rule !== undefined && isUserControlled(resource);

  return {
    ...finding,
    title: rule ? resolve(rule.title, context) : finding.message,
    impact: rule
      ? resolve(rule.impact, context)
      : "Not classified. See the technical details.",
    owner,
    remediation: rule
      ? remediationFor(rule, context, owner)
      : "No guidance is available for this rule yet.",
    evidence: rule?.evidence ? rule.evidence(context) : finding.message,
    actionable: userControlled,
  };
}

export function describeFindings(
  findings: readonly Finding[],
  resources: readonly ResourceRecord[],
): Finding[] {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return findings.map((finding) =>
    describeFinding(
      finding,
      finding.resourceId ? byId.get(finding.resourceId) : undefined,
    ),
  );
}

function remediationFor(
  rule: RuleDefinition,
  context: RuleContext,
  owner: FindingOwner,
): string {
  const { resource, provider, finding } = context;
  if (isUserControlled(resource)) {
    return rule.remediation;
  }
  if (finding.severity === "info") {
    return "None. Shown for reference only.";
  }
  switch (owner) {
    case "self":
      return `None by hand. ${provider} regenerates this copy.`;
    case "administrator":
      return `Managed by your administrator. ${rule.remediation}`;
    case "plugin":
      return `Managed by the plugin ${resource?.owner.id ?? "that ships it"}. Update or reinstall the plugin if the problem persists.`;
    case "package":
      return `Managed by the package ${resource?.owner.id ?? "that ships it"}. Update the package if the problem persists.`;
    case "provider":
      return resource
        ? `Managed by ${provider}. Update ${provider} if the problem persists.`
        : rule.remediation;
  }
}

function isUserControlled(resource: ResourceRecord | undefined): boolean {
  return resource?.owner.type === "self" && !resource.generated;
}

function resolve(
  value: string | ((context: RuleContext) => string),
  context: RuleContext,
): string {
  return typeof value === "function" ? value(context) : value;
}

function providerFromCode(code: string): ResourceRecord["provider"] | undefined {
  const prefix = code.split(".")[0];
  return prefix === "claude" ||
    prefix === "codex" ||
    prefix === "grok" ||
    prefix === "opencode" ||
    prefix === "hermes"
    ? prefix
    : undefined;
}

function skillDirectoryName(resource: ResourceRecord | undefined): string | undefined {
  if (!resource?.displayPath) {
    return undefined;
  }
  const segments = resource.displayPath.split("/");
  return segments.length >= 2 ? segments[segments.length - 2] : undefined;
}

function sameIgnoringCase(left: string | undefined, right: string | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left !== right &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function lastSegments(displayPath: string, count: number): string {
  return displayPath.split("/").slice(-count).join("/");
}
