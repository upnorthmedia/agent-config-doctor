# Agent Config Doctor

Agent Config Doctor is a local-first, read-only dashboard and CLI for inspecting the instructions, skills, plugins, and MCP servers that coding-agent harnesses can load. It separates everything installed on disk from the configuration effective for one repository and working directory.

No account, hosted service, or configuration migration is required.

## Requirements

- Node.js 24 or newer
- A supported provider executable on `PATH` for each provider you want to
  inspect. Missing providers are reported as unavailable.
- A local repository or directory to inspect

## Quick start

When the package is available from npm, launch the dashboard without a global install:

```bash
npx agent-config-doctor
npx agent-config-doctor /path/to/repository
```

The dashboard binds to an available port on `127.0.0.1`, prints its local URL, opens the default browser, and runs until you press `Ctrl-C`.

For a headless session or when you want to open the printed URL yourself:

```bash
npx agent-config-doctor /path/to/repository --no-open
```

To run a source checkout directly:

```bash
npm ci
npm run build
node dist/cli.js /path/to/repository --no-open
```

## CLI

### Dashboard

```bash
npx agent-config-doctor [path] [--no-open] [--editor <name>]
npx agent-config-doctor --version
```

`path` defaults to the current working directory and is the only working directory the dashboard scans. `--version` (or `-v`) prints the package version and exits; the dashboard header shows the same version. To inspect a different directory, launch Agent Config Doctor again with that path.

Each dashboard page answers one question and has its own URL, so reload restores the page and the browser's Back button returns to the previous one:

| Route | Question | Contents |
| --- | --- | --- |
| `/` | Is my setup healthy here? | One summary per provider: loaded instructions, available skills, enabled integrations, actionable findings, and scan-completeness notices. |
| `/installed` | What configuration exists? | Everything discovered, grouped as My configuration, Administrator configuration, Plugins, Provider-managed, and Elsewhere in repository. Plugins, provider-managed, and elsewhere groups start collapsed with their counts visible. Search and filters live in the URL query. |
| `/effective` | What will this harness use in this directory? | Loaded instructions in precedence order, skills available on demand, enabled MCP servers and plugins, other decisions with plain reasons, and a collapsed section for unrelated repository resources. |
| `/findings` | What should I fix? | Problems in files you control first, each with a title, impact, owner, file, and action. Rule codes, confidence, evidence, and the raw message sit under Technical details. Provider-managed notes and findings elsewhere in the repository are collapsed. |
| `/resources/<id>` | What is this file and why does it matter? | A plain-text preview for instruction and skill files, the effective status, validation, copy, reveal, and open actions, metadata, then collapsed redacted provider data and raw JSON. |

Status labels are written for operators: an instruction in the chain is "Loaded", a valid skill is "Available on demand", a configured MCP server or plugin is "Enabled", a file found outside the chain is "Elsewhere in repository", and a bad path or unreadable file is "Missing" or "Blocked". Scan failures are operational notices, never findings against your configuration, and never change the finding counts.

### File previews

The resource detail page shows the text of file-backed instruction and skill documents exactly as written on disk, with line numbers and wrapping, so you can see what an agent will read. Configuration files (MCP, plugin, and provider settings) are never previewed raw; they keep their structured, redacted metadata. Previews are bounded: files over 1 MiB are refused, at most the first 256 KiB is shown with an explicit truncation note, content must be UTF-8 text, binary content is refused, and empty files are reported as empty. Before reading, the server revalidates the opaque resource ID, opens the recorded canonical file without following a final symlink, and compares device and inode with the scan; a file that was replaced or redirected after the scan is refused.

Preview text may contain sensitive material such as internal names, hostnames, or credentials. The page warns about this; review it before sharing a screenshot. Exported JSON stays redacted.

`--editor` selects one detected GUI editor from `code`, `cursor`, `zed`, or `subl`. Agent Config Doctor never accepts an arbitrary editor command. If no supported editor is available, copy-path and reveal actions remain available.

### JSON scan

```bash
npx agent-config-doctor scan /path/to/repository --json
```

Omit the path to scan the current working directory:

```bash
npx agent-config-doctor scan --json
```

The command writes only schema-versioned JSON to stdout. Status, errors, and scan notices use stderr. The report uses the same normalized records as the dashboard.

### Scope of a scan

Effective configuration is built only from the selected directory and its real ancestor chain up to the repository root, plus the provider's user, administrator, and provider-managed locations. The whole repository is still walked so that every instruction file, skill, plugin, and MCP definition stays visible, but a file found outside that chain (a sibling package, a test fixture, a nested synthetic home directory) is reported with `reach: "repository"`, is never active, and is left out of the overview totals. The dashboard lists those resources under "Elsewhere in repository" and the `doctor` summary counts them separately.

The repository walk skips version-control and generated directories: `.git`, `.hg`, `.svn`, `node_modules`, `dist`, `build`, `coverage`, `.venv`, `venv`, `__pycache__`, `.cache`, `.next`, `.turbo`, `.tox`, `.mypy_cache`, and `.pytest_cache`. A directory with one of those names is still walked when it lies on the selected directory's ancestor chain, so launching from inside such a directory never hides the configuration beside it. Directory symlinks are not followed.

### Doctor summary

```bash
npx agent-config-doctor doctor /path/to/repository
```

`doctor` prints provider, resource, and finding counts, then starts a protected dashboard without opening a browser. It remains active until you press `Ctrl-C`.

## Provider support

Agent Config Doctor applies discovery rules only to recognized versions. Other installed versions are reported as unsupported instead of being scanned with guessed behavior.

| Provider | Supported version | v1 coverage | Boundary |
| --- | --- | --- | --- |
| Claude Code | 2.1.x | Managed, user, project, local, nested, and imported instructions; skills; plugins; MCP servers | Uses `claude plugin list --json` plus parsed files. Hooks and agent definitions are not emitted. |
| Codex | 0.117.x through 0.154.x | Global and project instruction chains; fallback names; skills; plugins; standalone and plugin MCP servers | Uses read-only plugin and MCP list commands plus parsed files. Hooks and agent definitions are not emitted. |
| Grok Build | 1.0.x | Native instruction order; compatibility skills; plugins; MCP servers; trust and policy state | Requires valid `grok inspect --json` output. Hook and agent capabilities are not emitted as inventory records in v1. |
| OpenCode | 1.18.x | Global and project instruction precedence including `CLAUDE.md` and `CONTEXT.md` fallbacks and `instructions` globs; skills from every documented location plus the built-in `customize-opencode` skill; configured and directory plugins; merged MCP servers; `OPENCODE_DISABLE_*` flags; missing references | Parse-only. `opencode debug` commands are not used because they print provider API keys and full skill bodies and write to the OpenCode database. Remote `instructions` URLs, `skills.urls`, and `OPENCODE_CONFIG_CONTENT` are recorded but not fetched or parsed. Agent definitions are not emitted. 2.x rules are documented in the isolated v2 module but are not verified against a released binary, so 2.x is reported as unsupported. |
| Hermes | 0.12.x | Context priority; bundled, hub, protected, external, and plugin skills; plugins; MCP servers and allowlists | Filesystem and configuration inference only. Hooks and agent definitions are not emitted. |

Providers must be installed for their configuration to be scanned. Missing executables are shown as unavailable.

### Native inspection and scan completeness

Native listing commands (`claude plugin list --json`, `codex plugin list --json`, `codex mcp list --json`, `grok inspect --json`) run asynchronously with a 15 second budget each, so a slow provider start does not block the others. A command that times out, exits with an error, returns malformed JSON, returns more than 10 MB, or cannot be started is recorded as a scan notice instead of being treated as "no native data". Notices name the provider and the command, explain which evidence is incomplete, and say how to rerun the scan. They appear in the JSON report under `notices`, on stderr for `scan --json`, in the `doctor` summary, and as a banner in the dashboard. Notices are operational; they are never findings against your configuration and never change the error count. Each entry in `providers` also carries `complete: false` while its evidence is incomplete.

## JSON report

Every report carries `schemaVersion: 1`. Versions 1.0.1 and 1.1.0 add optional fields only; existing fields keep their meaning.

| Field | Values | Meaning |
| --- | --- | --- |
| `resources[].reach` | `chain`, `repository` | Whether the resource applies to the selected directory's ancestor chain or was only found elsewhere in the repository. |
| `resources[].loadMode` | `context-loaded`, `on-demand`, `explicitly-enabled` | Instructions load into context, skills are available on demand, plugins and MCP servers must be enabled. |
| `resources[].generated` | `true` when present | Caches and provider runtime copies (plugin caches, Codex system skills, Grok bundled skills, Hermes bundled copies) that the user does not author. |
| `resources[].owner.type` | `self`, `administrator`, `plugin`, `package`, `provider` | Who controls the file. `self` means the user. Codex marketplace plugins, Grok bundled skills, and Hermes bundled or protected skills are `provider` owned. |
| `findings[].reach` | `repository` when present | The finding belongs to a resource found outside the selected directory's ancestor chain. It keeps its real severity but is left out of the overview and `doctor` totals, which report such findings separately as "elsewhere in repository". |
| `providers[].complete` | boolean | `false` when a native inspection command for that provider failed. |
| `findings[].title` | string | Operator-facing headline from the rule catalog (1.1.0). |
| `findings[].impact` | string | What the problem changes for the provider, in plain language (1.1.0). |
| `findings[].owner` | `self`, `administrator`, `plugin`, `package`, `provider` | Who controls the file the finding is about; `provider` for findings that have no resource (1.1.0). |
| `findings[].remediation` | string | What to do, addressed to whoever controls the file (1.1.0). |
| `findings[].evidence` | string | The concrete evidence behind the finding (1.1.0). |
| `findings[].actionable` | boolean | `true` only when the user controls the file and can act on it. Provider, plugin, package, and administrator findings and generated copies are never actionable (1.1.0). |
| `notices[]` | `{ code, provider, command, message, remediation }` | Operational scan notices such as `native.command.timeout`. |

A display name that differs from its folder never invalidates a skill on its own. It is a medium-confidence warning when the user controls the skill and an informational finding when a provider, plugin, or package manages it.

## Read-only behavior

Agent Config Doctor does not edit, create, disable, update, uninstall, or delete provider configuration. It does not start configured MCP servers or evaluate commands found in provider configuration.

Provider detection runs each provider's `--version` command. Supported native inspection is limited to read-only listing commands such as `grok inspect --json`, `claude plugin list --json`, and Codex plugin and MCP list commands. OpenCode and Hermes are inspected by parsing files only.

Open-in-editor and reveal actions can launch a local application. The dashboard sends an opaque resource ID, and the server revalidates the discovered file, symlink target, inode, and allowed root immediately before launch. Processes use argument arrays with `shell: false`. Any edits made later inside the selected editor are outside Agent Config Doctor.

## Privacy and redaction

- Scans stay on the local machine. There is no telemetry, account, cloud sync, or upload.
- Scanning is limited to the selected repository, known provider configuration roots, and explicitly configured external skill locations.
- Public reports omit canonical resource paths and replace known path roots with labels such as `$REPO`, `$HOME`, and `$CODEX_HOME`.
- MCP environment values, arguments, credentials, URL user information, query strings, fragments, and static header values are not returned. Environment variable names, header names, command names, and sanitized URL hosts and paths can remain visible because they are diagnostic evidence.
- Instruction and skill previews in the dashboard are shown unmodified; nothing in that text is masked, because masking could change the meaning of an instruction. Previews exist only inside the authenticated local session and are never part of the JSON report.
- The dashboard keeps one scan in memory and writes no persistent database.

Redaction is a safety boundary, not a guarantee that every user-authored name is harmless to share. Review JSON output before posting it publicly, especially when filenames, hostnames, command names, or environment variable names are sensitive.

## Security model

- The server binds exclusively to `127.0.0.1` and rejects any other bind address.
- Every process gets an unpredictable session credential. The browser receives it in the URL fragment, stores it in session storage, and sends it as a bearer credential for protected API requests.
- State-changing local actions require an exact same-origin request. The server does not enable permissive CORS.
- The dashboard sends a restrictive Content Security Policy and renders scanned values as text.
- File actions and previews accept only current opaque IDs and revalidate the underlying target at action time. Preview responses are sent with `Cache-Control: no-store`.
- Only the page routes listed above are served; every other path is a 404. If a tab has no session credential (for example a URL pasted into a new tab), the dashboard asks you to relaunch and open the printed URL instead of falling back to a stored credential.
- Supported editor commands are allowlisted. Arbitrary shell templates and terminal editors are not supported.

Do not expose the dashboard through a proxy or port forward, and do not share its credential-bearing URL. A process running as the same operating-system user may already be able to read the same local files, so Agent Config Doctor is not a sandbox against a compromised local account.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting. Use GitHub private vulnerability reporting instead of a public issue for security-sensitive details.

## Limitations

- v1 supports only the provider version ranges in the table.
- Effective results are version-specific adapter output. Grok uses native inspection; other providers combine supported native listings with parsed files or filesystem inference.
- Hooks and agent definitions are part of the normalized model but are not yet populated by the v1 adapters.
- The tool does not analyze transcripts, measure resource usage, or claim that a resource is unused.
- It does not manage provider lifecycle actions or offer automatic cleanup.
- Very large repositories can take longer to scan because supported instruction and skill locations are inspected recursively, apart from the generated directories listed under "Scope of a scan".
- OpenCode support covers 1.18.x only. Remote instruction URLs and `skills.urls` are recorded without fetching, `OPENCODE_CONFIG_CONTENT` is not parsed, and skill override order follows discovery order while the OpenCode binary loads duplicates concurrently, so a duplicate name is reported as a warning rather than resolved with certainty.
- The dashboard scans the launch directory only; there is no in-app working directory switcher.
- The dashboard is a local process, not a background service. Closing the page does not stop it; press `Ctrl-C` in the launching terminal.

## License

[MIT](./LICENSE)
