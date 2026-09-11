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
```

`path` defaults to the current working directory. The dashboard contains overview, installed inventory, effective configuration, findings, and resource detail views. Search and filters operate on the current in-memory scan.

`--editor` selects one detected GUI editor from `code`, `cursor`, `zed`, or `subl`. Agent Config Doctor never accepts an arbitrary editor command. If no supported editor is available, copy-path and reveal actions remain available.

### JSON scan

```bash
npx agent-config-doctor scan /path/to/repository --json
```

Omit the path to scan the current working directory:

```bash
npx agent-config-doctor scan --json
```

The command writes only schema-versioned JSON to stdout. Status and errors use stderr. The report uses the same normalized records as the dashboard.

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
| OpenCode | 2.x | `AGENTS.md` order; native and compatibility skills; configured plugins and MCP servers | Filesystem and configuration inference only. Configured instruction fields stay visible but inactive. Agent definitions are not emitted. |
| Hermes | 0.12.x | Context priority; bundled, hub, protected, external, and plugin skills; plugins; MCP servers and allowlists | Filesystem and configuration inference only. Hooks and agent definitions are not emitted. |

Providers must be installed for their configuration to be scanned. Missing executables are shown as unavailable.

## Read-only behavior

Agent Config Doctor does not edit, create, disable, update, uninstall, or delete provider configuration. It does not start configured MCP servers or evaluate commands found in provider configuration.

Provider detection runs each provider's `--version` command. Supported native inspection is limited to read-only listing commands such as `grok inspect --json`, `claude plugin list --json`, and Codex plugin and MCP list commands.

Open-in-editor and reveal actions can launch a local application. The dashboard sends an opaque resource ID, and the server revalidates the discovered file, symlink target, inode, and allowed root immediately before launch. Processes use argument arrays with `shell: false`. Any edits made later inside the selected editor are outside Agent Config Doctor.

## Privacy and redaction

- Scans stay on the local machine. There is no telemetry, account, cloud sync, or upload.
- Scanning is limited to the selected repository, known provider configuration roots, and explicitly configured external skill locations.
- Public reports omit canonical resource paths and replace known path roots with labels such as `$REPO`, `$HOME`, and `$CODEX_HOME`.
- MCP environment values, arguments, credentials, URL user information, query strings, fragments, and static header values are not returned. Environment variable names, header names, command names, and sanitized URL hosts and paths can remain visible because they are diagnostic evidence.
- The dashboard keeps one scan in memory and writes no persistent database.

Redaction is a safety boundary, not a guarantee that every user-authored name is harmless to share. Review JSON output before posting it publicly, especially when filenames, hostnames, command names, or environment variable names are sensitive.

## Security model

- The server binds exclusively to `127.0.0.1` and rejects any other bind address.
- Every process gets an unpredictable session credential. The browser receives it in the URL fragment, stores it in session storage, and sends it as a bearer credential for protected API requests.
- State-changing local actions require an exact same-origin request. The server does not enable permissive CORS.
- The dashboard sends a restrictive Content Security Policy and renders scanned values as text.
- File actions accept only current opaque IDs and revalidate the underlying target at action time.
- Supported editor commands are allowlisted. Arbitrary shell templates and terminal editors are not supported.

Do not expose the dashboard through a proxy or port forward, and do not share its credential-bearing URL. A process running as the same operating-system user may already be able to read the same local files, so Agent Config Doctor is not a sandbox against a compromised local account.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting. Use GitHub private vulnerability reporting instead of a public issue for security-sensitive details.

## Limitations

- v1 supports only the provider version ranges in the table.
- Effective results are version-specific adapter output. Grok uses native inspection; other providers combine supported native listings with parsed files or filesystem inference.
- Hooks and agent definitions are part of the normalized model but are not yet populated by the v1 adapters.
- The tool does not analyze transcripts, measure resource usage, or claim that a resource is unused.
- It does not manage provider lifecycle actions or offer automatic cleanup.
- Very large repositories can take longer to scan because supported instruction and skill locations are inspected recursively.
- The dashboard is a local process, not a background service. Closing the page does not stop it; press `Ctrl-C` in the launching terminal.

## License

[MIT](./LICENSE)
