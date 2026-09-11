import type { ProviderAdapter, ScanContext } from "./provider-adapter.ts";
import { createScanReport, scanProvider } from "./scanner.ts";
import type {
  AggregateScanReport,
  ScanSnapshot,
} from "./schema.ts";

export interface CoordinatedScan {
  context: ScanContext;
  snapshots: ScanSnapshot[];
  report: AggregateScanReport;
}

export async function scanProviders(
  adapters: readonly ProviderAdapter[],
  context: ScanContext,
): Promise<CoordinatedScan> {
  if (adapters.length === 0) {
    throw new Error("At least one provider adapter is required.");
  }

  const snapshots = await Promise.all(
    adapters.map((adapter) => scanProvider(adapter, context)),
  );
  const reports = snapshots.map((snapshot) =>
    createScanReport(snapshot, context),
  );
  const effectiveEntries = reports.map((report) => [
    report.detection.provider,
    {
      providerVersion: report.detection.version,
      orderedResourceIds: report.effective.orderedResourceIds,
      decisions: report.effective.decisions,
    },
  ] as const);

  return {
    context,
    snapshots,
    report: {
      schemaVersion: reports[0]!.schemaVersion,
      subject: reports[0]!.subject,
      providers: reports.map((report) => report.detection),
      resources: reports
        .flatMap((report) => report.resources)
        .sort((left, right) =>
          `${left.provider}:${left.kind}:${left.displayPath ?? left.name}:${left.id}`.localeCompare(
            `${right.provider}:${right.kind}:${right.displayPath ?? right.name}:${right.id}`,
          ),
        ),
      effective: Object.fromEntries(effectiveEntries) as AggregateScanReport["effective"],
      findings: reports
        .flatMap((report) =>
          report.findings.map((finding) => ({
            ...finding,
            provider: report.detection.provider,
          })),
        )
        .sort((left, right) =>
          `${left.provider}:${left.code}:${left.resourceId ?? ""}:${left.message}`.localeCompare(
            `${right.provider}:${right.code}:${right.resourceId ?? ""}:${right.message}`,
          ),
        ),
    },
  };
}
