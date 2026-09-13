# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Verify with `npm run typecheck`, `npm test` (Node 24 built-in runner over `test/*.test.ts`, fixtures under `test/fixtures`), and `npm run build`. The suite includes a deliberate 5.5 second slow-Codex regression in `test/native-evidence.test.ts`.
- Scan model: effective configuration comes only from the selected directory's ancestor chain; everything else found in the repository is inventory with `reach: "repository"`. The enforcement point is `normalizeEffective` in `src/core/scanner.ts`; adapters set `reach` for repository files with `reachForDirectory` from `src/providers/shared.ts`. Scanning this repository itself must show zero fixture resources as effective (`test/scan-scope.test.ts`).
- Native provider commands go through `runNativeJson` in `src/providers/shared.ts`. A failure becomes a scan notice, never an empty successful result. Fixture executables that stall, fail, or return bad JSON live in `test/fixtures/codex/instruction-chain/bin`.
- The Codex golden fixture `test/fixtures/codex/instruction-chain/expected-scan.json` is a data contract: regenerate it deliberately and review the diff, never accept it wholesale.
- OpenCode is parse-only on purpose. `opencode debug config` prints provider API keys and `opencode debug skill` prints full skill bodies, and both write to the OpenCode database (spike on 1.18.30, see the commit that added `src/providers/opencode-v1.ts`). Only 1.18.x is supported; `src/providers/opencode-v2.ts` documents 2.x rules that are not verified against a released binary.
- The dashboard is one HTML document served on the allowlisted routes in `isPageRoute` (`src/server/server.ts`); the client reads the path. Findings get their operator wording from the rule catalog in `src/core/rules.ts`: add an entry there for every new finding code, or it falls back to the raw message and is never actionable.
- Previews (`src/server/preview.ts`) are limited to file-backed instruction and skill documents and reuse the action inventory's revalidation. Keep configuration files out of raw previews; they show structured redacted metadata instead.
- Fixture executables are Node scripts. Do not put a dot in their file names; Node refuses to load `bin/opencode-1.17` as a module.
- Do not push, tag, or publish from a task branch. Releases are explicit actions outside normal work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
