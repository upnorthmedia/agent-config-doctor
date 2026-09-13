import { readFileSync } from "node:fs";

let cachedVersion: string | undefined;

/**
 * The running package version, read from the package.json that ships next
 * to `dist/` (or `src/` when running from a checkout). Both layouts keep the
 * file one directory above this module's parent.
 */
export function packageVersion(): string {
  if (cachedVersion === undefined) {
    const metadata = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    cachedVersion =
      typeof metadata.version === "string" ? metadata.version : "unknown";
  }
  return cachedVersion;
}
