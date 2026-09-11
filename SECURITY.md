# Security Policy

## Supported versions

The latest published `1.0.x` version receives security fixes. Source snapshots, older minor versions, and prerelease versions are not supported unless this policy is updated.

## Report a vulnerability

Use GitHub private vulnerability reporting from the repository's **Security** tab. Include:

- The affected version and operating system
- The provider and command involved
- Reproduction steps using non-sensitive fixtures
- Expected and observed behavior
- The security impact

Do not include credentials, tokens, private configuration, personal paths, or other secrets in a public issue.

If the private reporting option is unavailable, contact the repository maintainers through GitHub without disclosing vulnerability details publicly.

## Scope

Security reports are especially useful for:

- Disclosure of local paths, configuration values, or credentials
- Dashboard access outside the intended loopback and session boundary
- Cross-origin action requests
- Forged resource IDs or filesystem boundary bypasses
- Symlink or file-replacement races in open and reveal actions
- Shell execution or execution of configured MCP commands

Agent Config Doctor is a local inspection tool. A process that already runs as the same operating-system user may have direct access to the same files and is outside the dashboard's isolation boundary.
