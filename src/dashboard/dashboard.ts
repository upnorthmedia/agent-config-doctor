export function dashboardDocument(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Agent Config Doctor</title>
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
  <!--
  THESIS: One diagnostic workbench shows what every supported harness can load and why, without using a generic metric-card dashboard.
  OWN-WORLD: Near-black canvas, cool charcoal work surfaces, quiet dividers, compact system type, warm orange actions, and restrained semantic state colors.
  STORY: Scan the local environment, compare installed and effective resources, inspect findings, then copy, reveal, or open a revalidated source.
  FIRST VIEWPORT: A slim product header sits above fixed navigation and a dense working canvas. Context controls stay near the effective data they change.
  FORM: Precise extension of the approved prototype in Operate mode. Seed key: precise-prototype-extension.
  FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
  -->
  <div class="app-shell">
    <header class="app-header">
      <a class="brand" href="#overview" data-view="overview" aria-label="Agent Config Doctor overview"><span>Agent Config</span> Doctor</a>
      <div class="scan-context">
        <span class="scan-dot" aria-hidden="true"></span>
        <span id="header-context">Reading local configuration</span>
      </div>
    </header>

    <aside class="side-nav" aria-label="Dashboard views">
      <nav>
        <button class="nav-item is-active" type="button" data-view="overview">Overview</button>
        <button class="nav-item" type="button" data-view="installed">Installed inventory</button>
        <button class="nav-item" type="button" data-view="effective">Effective config</button>
        <button class="nav-item" type="button" data-view="findings">Findings</button>
        <button class="nav-item" type="button" data-view="detail" id="detail-nav" disabled>Resource detail</button>
      </nav>
      <div class="nav-note">
        <span class="nav-note-label">Local session</span>
        <span>Read-only, loopback protected</span>
      </div>
    </aside>

    <main class="workspace">
      <div class="session-error" id="session-error" role="alert" hidden></div>
      <div class="scan-notices" id="scan-notices" role="status" hidden></div>
      <section class="view" id="view-overview" data-view-panel="overview">
        <div class="view-heading">
          <div>
            <h1>Configuration at a glance</h1>
            <p>One scan across installed harnesses, normalized without hiding provider differences. Totals cover the selected working directory and its ancestors; everything else found in the repository is listed separately in the inventory.</p>
          </div>
          <span class="scan-time" id="scan-time">Scanning</span>
        </div>
        <div class="summary-band" aria-label="Inventory summary">
          <div><strong id="summary-providers">0</strong><span>detected providers</span></div>
          <div><strong id="summary-resources">0</strong><span>resources in this context</span></div>
          <div><strong id="summary-active">0</strong><span>active resources</span></div>
          <div><strong id="summary-findings">0</strong><span>high confidence findings</span></div>
        </div>
        <div class="breakdown-band" aria-label="Resource breakdown">
          <section><h2>By kind</h2><div class="breakdown-list" id="kind-breakdown"></div></section>
          <section><h2>By state</h2><div class="breakdown-list" id="state-breakdown"></div></section>
        </div>
        <div class="empty-state" id="new-user-empty" hidden>
          <h2>Your local scan is ready</h2>
          <p>No supported agent configuration was discovered for this location. Add a provider instruction file or skill, then rerun Agent Config Doctor. The dashboard will keep unavailable providers visible so the first scan still explains what was checked.</p>
          <code>agent-config-doctor scan . --json</code>
        </div>
        <section class="section-block" aria-labelledby="providers-heading">
          <div class="section-heading"><h2 id="providers-heading">Provider coverage</h2><span id="provider-count"></span></div>
          <div class="provider-list" id="provider-list"></div>
        </section>
        <section class="section-block" aria-labelledby="priority-heading">
          <div class="section-heading"><h2 id="priority-heading">Priority findings</h2><button class="text-button" type="button" data-view="findings">View all findings</button></div>
          <div class="finding-list" id="priority-findings"></div>
        </section>
      </section>

      <section class="view" id="view-installed" data-view-panel="installed" hidden>
        <div class="view-heading">
          <div><h1>Installed inventory</h1><p>Discovered does not mean active. Search and narrow the complete local inventory.</p></div>
          <span class="result-count" id="inventory-count">0 resources</span>
        </div>
        <div class="filter-bar">
          <label class="search-field"><span>Search inventory</span><input id="inventory-search" type="search" placeholder="Name, path, owner, or source" autocomplete="off"></label>
          <label><span>Provider</span><select id="provider-filter"><option value="all">All providers</option></select></label>
          <label><span>Kind</span><select id="kind-filter"><option value="all">All kinds</option></select></label>
          <label><span>State</span><select id="state-filter"><option value="all">All states</option></select></label>
        </div>
        <div class="inventory-list" id="inventory-list"></div>
      </section>

      <section class="view" id="view-effective" data-view-panel="effective" hidden>
        <div class="view-heading">
          <div><h1>Effective configuration</h1><p>The ordered resources this harness resolves for the selected working directory.</p></div>
        </div>
        <div class="context-controls">
          <label><span>Provider</span><select id="effective-provider"></select></label>
          <div class="cwd-control"><span>Working directory</span><code id="working-directory"></code></div>
        </div>
        <div class="effective-summary" id="effective-summary"></div>
        <div class="effective-list" id="effective-list"></div>
      </section>

      <section class="view" id="view-findings" data-view-panel="findings" hidden>
        <div class="view-heading">
          <div><h1>Findings</h1><p>Deterministic checks and bounded evidence, ordered by severity and confidence.</p></div>
          <span class="result-count" id="finding-count">0 findings</span>
        </div>
        <div class="finding-list finding-list-full" id="finding-list"></div>
      </section>

      <section class="view" id="view-detail" data-view-panel="detail" hidden>
        <div class="view-heading detail-heading">
          <div><h1 id="detail-title">Resource detail</h1><p id="detail-subtitle">Select a resource from inventory, effective config, or findings.</p></div>
          <div class="action-row" id="resource-actions" hidden>
            <button type="button" id="copy-path">Copy path</button>
            <button type="button" id="reveal-resource">Reveal</button>
            <button class="primary-button" type="button" id="open-resource">Open in editor</button>
          </div>
        </div>
        <div class="detail-empty" id="detail-empty"><p>No resource selected yet.</p><button type="button" data-view="installed">Browse installed inventory</button></div>
        <div class="detail-layout" id="detail-content" hidden>
          <section class="detail-section"><h2>Normalized metadata</h2><dl id="detail-metadata"></dl></section>
          <section class="detail-section"><h2>Effective status</h2><div id="detail-effective"></div></section>
          <section class="detail-section detail-preview"><h2>Redacted provider data</h2><pre id="detail-preview"></pre></section>
          <section class="detail-section"><h2>Validation</h2><div class="finding-list" id="detail-findings"></div></section>
        </div>
      </section>
    </main>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="/assets/dashboard.js" defer></script>
</body>
</html>`;
}

export const dashboardStyles = `
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #171a21;
  --panel-2: #1e222b;
  --panel-3: #242934;
  --border: #2a2f3a;
  --border-strong: #3a414f;
  --text: #e6e8ee;
  --muted: #929bad;
  --quiet: #687184;
  --accent: #d97757;
  --accent-hover: #ef9b7e;
  --ok: #4ac26b;
  --warn: #d6a43c;
  --error: #f16d67;
  --info: #7aa2d8;
  --focus: #f0a082;
  --inset: #0b0d12;
  --inverse-text: #fff;
  --error-text: #ffd5d2;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.45; }
button, input, select { font: inherit; }
button, select { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.45; }
::selection { background: color-mix(in srgb, var(--accent) 38%, transparent); color: var(--inverse-text); }
* { scrollbar-color: var(--border-strong) var(--panel); scrollbar-width: thin; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
[hidden] { display: none !important; }

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  grid-template-rows: 48px minmax(0, 1fr);
  grid-template-areas: "header header" "nav workspace";
}

.app-header {
  grid-area: header;
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.brand { color: var(--text); font-weight: 650; text-decoration: none; letter-spacing: 0.01em; }
.brand span { color: var(--accent); }
.scan-context { margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 12px; }
.scan-context span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scan-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--ok); box-shadow: 0 2px 8px color-mix(in srgb, var(--ok) 22%, transparent); }

.side-nav {
  grid-area: nav;
  position: sticky;
  top: 48px;
  height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  padding: 10px 8px;
  background: var(--panel);
  border-right: 1px solid var(--border);
}

.side-nav nav { display: grid; gap: 3px; }
.nav-item {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  text-align: left;
  transition: background-color 160ms ease-out, color 160ms ease-out, border-color 160ms ease-out;
}
.nav-item:hover { color: var(--text); background: var(--panel-2); }
.nav-item.is-active { color: var(--text); background: var(--panel-2); border-color: var(--border); }
.nav-note { margin-top: auto; padding: 12px 10px 4px; display: grid; gap: 3px; color: var(--quiet); font-size: 11px; border-top: 1px solid var(--border); }
.nav-note-label { color: var(--muted); font-weight: 650; }

.workspace { grid-area: workspace; min-width: 0; padding: 30px clamp(20px, 4vw, 54px) 56px; }
.view { width: min(1180px, 100%); margin: 0 auto; }
.view-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
.view-heading h1 { margin: 0 0 5px; font-size: 21px; line-height: 1.2; letter-spacing: -0.02em; }
.view-heading p { max-width: 72ch; margin: 0; color: var(--muted); }
.scan-time, .result-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }

.session-error { width: min(1180px, 100%); margin: 0 auto 20px; padding: 10px 12px; color: var(--error-text); background: color-mix(in srgb, var(--error) 9%, transparent); border: 1px solid color-mix(in srgb, var(--error) 35%, transparent); border-radius: 6px; }
.scan-notices { width: min(1180px, 100%); margin: 0 auto 20px; display: grid; gap: 8px; }
.scan-notice { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--warn) 8%, transparent); color: var(--text); }
.scan-notice strong { display: block; margin-bottom: 3px; color: var(--warn); font-size: 12px; }
.scan-notice p { margin: 0; color: var(--muted); font-size: 12px; }
.scan-notice p + p { margin-top: 4px; }
.status-badge.incomplete { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent); }
.summary-band { display: grid; grid-template-columns: repeat(4, 1fr); margin-bottom: 32px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.summary-band > div { min-width: 0; padding: 16px 18px; display: grid; gap: 3px; border-right: 1px solid var(--border); }
.summary-band > div:last-child { border-right: 0; }
.summary-band strong { font-size: 20px; line-height: 1; font-weight: 680; font-variant-numeric: tabular-nums; }
.summary-band span { color: var(--muted); font-size: 11px; }
.breakdown-band { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: -18px 0 32px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--border); }
.breakdown-band section { min-width: 0; padding: 12px 16px; background: var(--panel); }
.breakdown-band h2 { margin: 0 0 8px; color: var(--muted); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.05em; }
.breakdown-list { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.breakdown-item { display: inline-flex; gap: 5px; color: var(--muted); font-size: 11px; text-transform: capitalize; }
.breakdown-item strong { color: var(--text); font-variant-numeric: tabular-nums; }

.section-block { margin-top: 30px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 9px; }
.section-heading h2, .detail-section h2 { margin: 0; font-size: 13px; font-weight: 650; }
.section-heading > span { color: var(--quiet); font-size: 11px; }
.text-button { padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 12px; }
.text-button:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 3px; }

.provider-list, .finding-list, .effective-list, .inventory-list { border-top: 1px solid var(--border); }
.provider-row { display: grid; grid-template-columns: minmax(130px, 1fr) 110px 110px 100px; align-items: center; gap: 14px; min-height: 48px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.provider-name { font-weight: 620; }
.provider-version, .provider-resource-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.status-badge { justify-self: start; padding: 2px 7px; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--muted); font-size: 10px; text-transform: capitalize; }
.status-badge.active, .status-badge.supported { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: color-mix(in srgb, var(--ok) 7%, transparent); }
.status-badge.blocked, .status-badge.invalid, .status-badge.error { color: var(--error); border-color: color-mix(in srgb, var(--error) 35%, transparent); background: color-mix(in srgb, var(--error) 7%, transparent); }
.status-badge.shadowed, .status-badge.disabled, .status-badge.warning, .status-badge.unsupported { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent); }

.filter-bar, .context-controls { display: grid; grid-template-columns: minmax(240px, 1.5fr) repeat(3, minmax(130px, 0.65fr)); gap: 10px; margin-bottom: 20px; padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
.context-controls { grid-template-columns: minmax(180px, 0.6fr) minmax(280px, 1.4fr); }
.filter-bar label, .context-controls label, .context-controls .cwd-control { display: grid; gap: 5px; color: var(--muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.045em; }
.cwd-control code { display: flex; align-items: center; min-height: 34px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); font: 12px ui-monospace, "SFMono-Regular", Consolas, monospace; text-transform: none; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input, select { width: 100%; min-height: 34px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); outline: none; }
input::placeholder { color: var(--muted); }
input:hover, select:hover { border-color: var(--border-strong); }
input:focus, select:focus { border-color: var(--accent); }

.inventory-group { margin-bottom: 20px; }
.inventory-group-heading { display: flex; justify-content: space-between; gap: 12px; padding: 8px 3px; color: var(--muted); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.055em; }
.resource-row { width: 100%; display: grid; grid-template-columns: minmax(180px, 1.4fr) 90px 80px 80px minmax(160px, 1fr) 82px; align-items: center; gap: 12px; min-height: 49px; padding: 8px 10px; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; color: var(--text); text-align: left; }
.resource-row:first-of-type { border-top: 1px solid var(--border); }
.resource-row:hover { background: var(--panel); }
.resource-row.is-selected { background: var(--panel-2); }
.resource-name { min-width: 0; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-kind, .resource-provider, .resource-scope { color: var(--muted); font-size: 11px; text-transform: capitalize; }
.resource-path { min-width: 0; color: var(--quiet); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.finding-row { display: grid; grid-template-columns: 76px 92px 110px minmax(0, 1fr) minmax(180px, 0.55fr); gap: 12px; align-items: start; padding: 11px 8px; border-bottom: 1px solid var(--border); }
.finding-confidence { color: var(--muted); font-size: 11px; text-transform: capitalize; }
.finding-code { color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }
.finding-message { color: var(--text); }
.finding-source { min-width: 0; padding: 0; border: 0; background: none; color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.finding-source:not(:disabled):hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }

.effective-summary { margin: 4px 0 10px; color: var(--muted); font-size: 12px; }
.effective-row { display: grid; grid-template-columns: 38px minmax(170px, 0.8fr) 92px minmax(220px, 1.5fr); gap: 12px; align-items: start; padding: 11px 8px; border-bottom: 1px solid var(--border); }
.effective-order { color: var(--quiet); font-variant-numeric: tabular-nums; text-align: right; }
.effective-name { padding: 0; border: 0; background: none; color: var(--text); text-align: left; font-weight: 620; }
.effective-name:hover { color: var(--accent); }
.effective-reason { color: var(--muted); }

button { min-height: 32px; padding: 6px 11px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); transition: border-color 160ms ease-out, background-color 160ms ease-out, color 160ms ease-out; }
button:hover:not(:disabled) { border-color: var(--accent); }
.primary-button { background: var(--accent); border-color: var(--accent); color: var(--inverse-text); }
.primary-button:hover:not(:disabled) { background: var(--accent-hover); }
.action-row { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
.detail-heading { align-items: center; }
.detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px 36px; }
.detail-section { min-width: 0; }
.detail-section h2 { margin-bottom: 10px; }
.detail-section dl { margin: 0; border-top: 1px solid var(--border); }
.detail-section dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; padding: 8px 3px; border-bottom: 1px solid var(--border); }
.detail-section dt { color: var(--muted); }
.detail-section dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.detail-preview { grid-column: 1 / -1; }
pre { max-height: 330px; margin: 0; padding: 14px 16px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--inset); color: var(--text); font: 12px/1.55 ui-monospace, "SFMono-Regular", Consolas, monospace; tab-size: 2; }
.effective-detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 3px; border-bottom: 1px solid var(--border); }
.effective-detail-row span:last-child { color: var(--muted); text-align: right; }
.detail-empty, .empty-state, .list-empty { padding: 28px; border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--muted); text-align: center; }
.empty-state { margin-bottom: 30px; text-align: left; background: var(--panel); }
.empty-state h2 { margin: 0 0 7px; color: var(--text); font-size: 16px; }
.empty-state p { max-width: 72ch; margin: 0 0 14px; }
.empty-state code { display: inline-block; padding: 6px 9px; border-radius: 6px; background: var(--inset); color: var(--text); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }

.toast { position: fixed; right: 20px; bottom: 20px; z-index: 20; max-width: min(380px, calc(100vw - 40px)); padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--panel-3); color: var(--text); box-shadow: 0 12px 32px color-mix(in srgb, var(--bg) 70%, transparent); opacity: 0; pointer-events: none; transform: translateY(8px); transition: opacity 180ms ease-out, transform 180ms ease-out; }
.toast.is-visible { opacity: 1; transform: translateY(0); }
.toast.is-error { border-color: color-mix(in srgb, var(--error) 55%, transparent); color: var(--error-text); }

@media (max-width: 920px) {
  .filter-bar { grid-template-columns: repeat(3, 1fr); }
  .search-field { grid-column: 1 / -1; }
  .resource-row { grid-template-columns: minmax(180px, 1fr) 90px 80px 82px; }
  .resource-scope, .resource-path { display: none; }
  .finding-row { grid-template-columns: 70px 90px 100px minmax(0, 1fr); }
  .finding-source { grid-column: 4; }
}

@media (max-width: 760px) {
  .app-shell { display: block; }
  .app-header { height: 48px; }
  .side-nav { position: sticky; top: 48px; z-index: 9; height: auto; padding: 7px 8px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .side-nav nav { display: flex; min-width: max-content; gap: 4px; }
  .nav-item { width: auto; white-space: nowrap; }
  .nav-note { display: none; }
  .workspace { padding: 22px 14px 42px; }
  .view-heading, .detail-heading { display: grid; gap: 14px; }
  .scan-time, .result-count { justify-self: start; }
  .summary-band { grid-template-columns: 1fr 1fr; }
  .summary-band > div:nth-child(2) { border-right: 0; }
  .summary-band > div:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .breakdown-band { grid-template-columns: 1fr; }
  .context-controls, .filter-bar { grid-template-columns: 1fr; }
  .search-field { grid-column: auto; }
  .provider-row { grid-template-columns: minmax(120px, 1fr) 90px; }
  .provider-resource-count { display: none; }
  .provider-row .status-badge { justify-self: end; }
  .resource-row { grid-template-columns: minmax(0, 1fr) 70px 82px; }
  .resource-provider { display: none; }
  .resource-row .status-badge { justify-self: end; }
  .finding-row { grid-template-columns: 70px 90px minmax(0, 1fr); }
  .finding-code { grid-column: 3; }
  .finding-message, .finding-source { grid-column: 1 / -1; }
  .effective-row { grid-template-columns: 30px minmax(0, 1fr) 88px; }
  .effective-reason { grid-column: 2 / -1; }
  .detail-layout { grid-template-columns: 1fr; }
  .detail-preview { grid-column: auto; }
  .action-row { justify-content: flex-start; }
  .scan-context { max-width: 48vw; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
`;

export const dashboardClientScript = String.raw`
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const state = {
    report: null,
    options: null,
    selectedResourceId: null,
    view: "overview",
  };
  const actionEndpoints = {
    open: "/api/actions/open",
    reveal: "/api/actions/reveal",
  };
  let toastTimer;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function credential() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const supplied = fragment.get("credential");
    if (supplied) {
      sessionStorage.setItem("agent-config-doctor-credential", supplied);
      history.replaceState(null, "", location.pathname + location.search);
      return supplied;
    }
    return sessionStorage.getItem("agent-config-doctor-credential");
  }

  const sessionCredential = credential();

  async function api(endpoint, options = {}) {
    if (!sessionCredential) throw new Error("This dashboard URL is missing its local session credential. Relaunch Agent Config Doctor.");
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + sessionCredential);
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(endpoint, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "The local dashboard request failed.");
    return payload;
  }

  function showError(error) {
    const banner = byId("session-error");
    banner.textContent = error instanceof Error ? error.message : "The dashboard could not load.";
    banner.hidden = false;
  }

  function toast(message, isError = false) {
    const node = byId("toast");
    node.textContent = message;
    node.className = "toast is-visible" + (isError ? " is-error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.className = "toast"; }, 2400);
  }

  function providerLabel(provider) {
    return ({ claude: "Claude Code", codex: "Codex", grok: "Grok Build", opencode: "OpenCode", hermes: "Hermes" })[provider] || provider;
  }

  function plural(count, singular, pluralValue) {
    return count + " " + (count === 1 ? singular : (pluralValue || singular + "s"));
  }

  function resourceById(id) {
    return state.report.resources.find((resource) => resource.id === id);
  }

  function inContext(resource) {
    return resource.reach !== "repository";
  }

  function contextResources() {
    return state.report.resources.filter(inContext);
  }

  function switchView(view) {
    if (view === "detail" && !state.selectedResourceId) return;
    state.view = view;
    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== view;
    });
    document.querySelectorAll(".nav-item[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === view);
    });
    history.replaceState(null, "", "#" + view);
  }

  function statusBadge(value) {
    return element("span", "status-badge " + value, value);
  }

  function renderBreakdown(containerId, resources, key) {
    const counts = new Map();
    for (const resource of resources) {
      counts.set(resource[key], (counts.get(resource[key]) || 0) + 1);
    }
    const container = byId(containerId);
    container.replaceChildren();
    if (counts.size === 0) {
      container.append(element("span", "breakdown-item", "None discovered"));
      return;
    }
    for (const [label, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
      const item = element("span", "breakdown-item");
      item.append(element("strong", "", count), element("span", "", label));
      container.append(item);
    }
  }

  function renderNotices() {
    const container = byId("scan-notices");
    container.replaceChildren();
    const notices = state.report.notices || [];
    container.hidden = notices.length === 0;
    for (const notice of notices) {
      const item = element("div", "scan-notice");
      item.append(
        element("strong", "", "Scan incomplete for " + providerLabel(notice.provider) + ": " + notice.command),
        element("p", "", notice.message),
        element("p", "", notice.remediation),
      );
      container.append(item);
    }
  }

  function renderOverview() {
    const resources = contextResources();
    const active = resources.filter((resource) => resource.state === "active").length;
    const highConfidence = state.report.findings.filter((finding) => finding.confidence === "high");
    const detected = state.report.providers.filter((provider) => provider.installed).length;
    byId("summary-providers").textContent = detected;
    byId("summary-resources").textContent = resources.length;
    byId("summary-active").textContent = active;
    byId("summary-findings").textContent = highConfidence.length;
    const scannedAt = new Date(state.options.scannedAt);
    byId("scan-time").textContent = Number.isNaN(scannedAt.getTime())
      ? "Scan complete"
      : "Scanned " + scannedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    byId("header-context").textContent = state.report.subject.workingDirectory;
    byId("new-user-empty").hidden = state.report.resources.length !== 0;
    renderBreakdown("kind-breakdown", resources, "kind");
    renderBreakdown("state-breakdown", resources, "state");

    const providerList = byId("provider-list");
    providerList.replaceChildren();
    for (const provider of state.report.providers) {
      const row = element("div", "provider-row");
      row.append(
        element("span", "provider-name", providerLabel(provider.provider)),
        element("span", "provider-version", provider.installed ? provider.version : "not detected"),
        element("span", "provider-resource-count", plural(resources.filter((resource) => resource.provider === provider.provider).length, "resource")),
        statusBadge(provider.complete === false ? "incomplete" : provider.support),
      );
      providerList.append(row);
    }
    byId("provider-count").textContent = plural(state.report.providers.length, "adapter");

    const priority = byId("priority-findings");
    priority.replaceChildren();
    renderFindingsInto(priority, highConfidence.slice(0, 5));
  }

  function fillSelect(select, values, allLabel) {
    const selected = select.value;
    select.replaceChildren();
    if (allLabel) {
      const all = element("option", "", allLabel);
      all.value = "all";
      select.append(all);
    }
    for (const value of values) {
      const option = element("option", "", value.label);
      option.value = value.value;
      select.append(option);
    }
    if (Array.from(select.options).some((option) => option.value === selected)) select.value = selected;
  }

  function renderFilters() {
    fillSelect(byId("provider-filter"), state.report.providers.map((provider) => ({ value: provider.provider, label: providerLabel(provider.provider) })), "All providers");
    const kinds = [...new Set(state.report.resources.map((resource) => resource.kind))].sort();
    const states = [...new Set(state.report.resources.map((resource) => resource.state))].sort();
    fillSelect(byId("kind-filter"), kinds.map((value) => ({ value, label: value })), "All kinds");
    fillSelect(byId("state-filter"), states.map((value) => ({ value, label: value })), "All states");
  }

  function renderInventory() {
    const query = byId("inventory-search").value.trim().toLowerCase();
    const provider = byId("provider-filter").value;
    const kind = byId("kind-filter").value;
    const resourceState = byId("state-filter").value;
    const filtered = state.report.resources.filter((resource) => {
      if (provider !== "all" && resource.provider !== provider) return false;
      if (kind !== "all" && resource.kind !== kind) return false;
      if (resourceState !== "all" && resource.state !== resourceState) return false;
      if (!query) return true;
      const owner = resource.owner.id || resource.owner.type;
      return [resource.name, resource.displayPath, resource.origin, owner].some((value) => String(value || "").toLowerCase().includes(query));
    });
    byId("inventory-count").textContent = plural(filtered.length, "resource");
    const list = byId("inventory-list");
    list.replaceChildren();
    if (filtered.length === 0) {
      list.append(element("div", "list-empty", state.report.resources.length === 0 ? "No local resources were discovered. The provider coverage above shows what was checked." : "No resources match these filters."));
      return;
    }

    const elsewhereLabel = "Elsewhere in repository";
    const groups = new Map();
    for (const resource of filtered) {
      const key = !inContext(resource)
        ? elsewhereLabel
        : resource.owner.type === "plugin" ? "Plugin: " + (resource.owner.id || "unknown") : "Standalone resources";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(resource);
    }
    if (groups.has(elsewhereLabel)) {
      const elsewhere = groups.get(elsewhereLabel);
      groups.delete(elsewhereLabel);
      groups.set(elsewhereLabel, elsewhere);
    }
    for (const [label, resources] of groups) {
      const group = element("section", "inventory-group");
      const heading = element("div", "inventory-group-heading");
      heading.append(element("span", "", label), element("span", "", resources.length));
      group.append(heading);
      for (const resource of resources) group.append(resourceRow(resource));
      list.append(group);
    }
  }

  function resourceRow(resource) {
    const row = element("button", "resource-row" + (resource.id === state.selectedResourceId ? " is-selected" : ""));
    row.type = "button";
    row.append(
      element("span", "resource-name", resource.name),
      element("span", "resource-provider", providerLabel(resource.provider)),
      element("span", "resource-kind", resource.kind),
      element("span", "resource-scope", resource.scope),
      element("span", "resource-path", resource.displayPath || "No file path"),
      statusBadge(inContext(resource) ? resource.state : "elsewhere"),
    );
    row.addEventListener("click", () => selectResource(resource.id));
    return row;
  }

  function renderEffective() {
    const select = byId("effective-provider");
    const selectedProvider = select.value || state.report.providers[0]?.provider;
    const effective = state.report.effective[selectedProvider];
    const list = byId("effective-list");
    list.replaceChildren();
    if (!effective) {
      byId("effective-summary").textContent = "No effective model is available for this provider.";
      list.append(element("div", "list-empty", "This adapter did not return an effective configuration."));
      return;
    }
    const decisionById = new Map(effective.decisions.map((decision) => [decision.resourceId, decision]));
    const ordered = effective.orderedResourceIds.map((id) => decisionById.get(id)).filter(Boolean);
    const remaining = effective.decisions.filter((decision) => !effective.orderedResourceIds.includes(decision.resourceId));
    byId("effective-summary").textContent = plural(ordered.length, "active resource") + " in load order, " + plural(remaining.length, "other decision");
    const decisions = [...ordered, ...remaining];
    if (decisions.length === 0) {
      list.append(element("div", "list-empty", "No resources are effective for this provider and working directory."));
      return;
    }
    decisions.forEach((decision, index) => {
      const resource = resourceById(decision.resourceId);
      if (!resource) return;
      const row = element("div", "effective-row");
      row.append(element("span", "effective-order", decision.order === undefined ? "" : String(decision.order + 1)));
      const name = element("button", "effective-name", resource.name);
      name.type = "button";
      name.addEventListener("click", () => selectResource(resource.id));
      row.append(name, statusBadge(decision.state), element("span", "effective-reason", decision.reason));
      list.append(row);
    });
  }

  function renderFindingsInto(container, findings) {
    if (findings.length === 0) {
      container.append(element("div", "list-empty", "No findings in this view."));
      return;
    }
    for (const finding of findings) {
      const row = element("div", "finding-row");
      row.append(
        statusBadge(finding.severity),
        element("span", "finding-confidence", finding.confidence + " confidence"),
        element("span", "finding-code", finding.code),
        element("span", "finding-message", finding.message),
      );
      const resource = finding.resourceId ? resourceById(finding.resourceId) : null;
      const sourceLabel = resource
        ? providerLabel(finding.provider) + " | " + (resource.displayPath || resource.name)
        : providerLabel(finding.provider);
      const source = element("button", "finding-source", sourceLabel);
      source.type = "button";
      source.disabled = !resource;
      if (resource) source.addEventListener("click", () => selectResource(resource.id));
      row.append(source);
      container.append(row);
    }
  }

  function renderFindings() {
    const severityOrder = { error: 0, warning: 1, info: 2 };
    const findings = [...state.report.findings].sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.code.localeCompare(right.code));
    byId("finding-count").textContent = plural(findings.length, "finding");
    const list = byId("finding-list");
    list.replaceChildren();
    renderFindingsInto(list, findings);
  }

  function detailPair(label, value) {
    const row = element("div", "");
    row.append(element("dt", "", label), element("dd", "", value));
    return row;
  }

  function selectResource(resourceId) {
    state.selectedResourceId = resourceId;
    byId("detail-nav").disabled = false;
    renderDetail();
    renderInventory();
    switchView("detail");
  }

  function renderDetail() {
    const resource = resourceById(state.selectedResourceId);
    if (!resource) return;
    byId("detail-title").textContent = resource.name;
    byId("detail-subtitle").textContent = providerLabel(resource.provider) + " " + resource.kind + " at " + (resource.displayPath || "a non-file source");
    byId("detail-empty").hidden = true;
    byId("detail-content").hidden = false;
    const metadata = byId("detail-metadata");
    metadata.replaceChildren(
      detailPair("Provider", providerLabel(resource.provider) + " " + resource.providerVersion),
      detailPair("Kind", resource.kind),
      detailPair("Scope", resource.scope),
      detailPair("Reach", inContext(resource) ? "In the selected context chain" : "Elsewhere in repository"),
      detailPair("State", resource.state),
      detailPair("Origin", resource.origin),
      detailPair("Owner", resource.owner.id || resource.owner.type),
      detailPair("Evidence", resource.evidenceType + ": " + resource.evidenceReceipt),
      detailPair("Source", resource.displayPath || "Not file-backed"),
    );
    const effective = byId("detail-effective");
    effective.replaceChildren();
    for (const provider of state.report.providers) {
      const decision = state.report.effective[provider.provider]?.decisions.find((item) => item.resourceId === resource.id);
      const row = element("div", "effective-detail-row");
      row.append(element("span", "", providerLabel(provider.provider)), element("span", "", decision ? decision.state + ": " + decision.reason : "Not applicable"));
      effective.append(row);
    }
    byId("detail-preview").textContent = JSON.stringify({ precedence: resource.precedence, capabilities: resource.capabilities, metadata: resource.metadata }, null, 2);
    const findings = byId("detail-findings");
    findings.replaceChildren();
    renderFindingsInto(findings, state.report.findings.filter((finding) => finding.resourceId === resource.id));

    const actionable = state.options.actionableResourceIds.includes(resource.id);
    byId("resource-actions").hidden = !actionable;
    byId("open-resource").disabled = !state.options.editor;
    byId("open-resource").title = state.options.editor ? "Open in " + state.options.editor.label : "No supported GUI editor detected";
  }

  function renderControls() {
    const providerSelect = byId("effective-provider");
    const previousProvider = providerSelect.value;
    fillSelect(providerSelect, state.report.providers.map((provider) => ({ value: provider.provider, label: providerLabel(provider.provider) })), null);
    if (previousProvider && state.report.effective[previousProvider]) providerSelect.value = previousProvider;
    byId("working-directory").textContent = state.options.workingDirectory;
  }

  function renderAll() {
    renderNotices();
    renderOverview();
    renderFilters();
    renderInventory();
    renderControls();
    renderEffective();
    renderFindings();
    if (state.selectedResourceId) renderDetail();
  }

  async function resourceAction(action) {
    if (!state.selectedResourceId) return;
    try {
      if (action === "copy") {
        const result = await api("/api/resources/" + encodeURIComponent(state.selectedResourceId) + "/path");
        await navigator.clipboard.writeText(result.path);
        toast("Path copied.");
        return;
      }
      await api(actionEndpoints[action], { method: "POST", body: JSON.stringify({ resourceId: state.selectedResourceId }) });
      toast(action === "open" ? "Opened in editor." : "Revealed in file manager.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "The action failed.", true);
    }
  }

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      switchView(button.dataset.view);
    });
  });
  ["inventory-search", "provider-filter", "kind-filter", "state-filter"].forEach((id) => {
    byId(id).addEventListener(id === "inventory-search" ? "input" : "change", renderInventory);
  });
  byId("effective-provider").addEventListener("change", renderEffective);
  byId("copy-path").addEventListener("click", () => resourceAction("copy"));
  byId("reveal-resource").addEventListener("click", () => resourceAction("reveal"));
  byId("open-resource").addEventListener("click", () => resourceAction("open"));

  Promise.all([api("/api/scan"), api("/api/options")])
    .then(([report, options]) => {
      state.report = report;
      state.options = options;
      renderAll();
      const requestedView = location.hash.slice(1);
      switchView(["overview", "installed", "effective", "findings"].includes(requestedView) ? requestedView : "overview");
    })
    .catch(showError);
})();
`;
