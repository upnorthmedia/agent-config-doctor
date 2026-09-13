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
      <a class="brand" href="/" data-view="overview" aria-label="Agent Config Doctor overview"><span>Agent Config</span> Doctor</a>
      <div class="scan-context">
        <span class="scan-dot" aria-hidden="true"></span>
        <span id="header-context">Reading local configuration</span>
      </div>
    </header>

    <aside class="side-nav" aria-label="Dashboard views">
      <nav>
        <a class="nav-item is-active" href="/" data-view="overview">Overview</a>
        <a class="nav-item" href="/installed" data-view="installed">Installed</a>
        <a class="nav-item" href="/effective" data-view="effective">Effective</a>
        <a class="nav-item" href="/findings" data-view="findings">Findings</a>
        <a class="nav-item" href="/" data-view="detail" id="detail-nav" hidden>Resource detail</a>
      </nav>
      <div class="nav-note">
        <span class="nav-note-label">Local session</span>
        <span>Read-only, loopback protected</span>
        <span class="nav-version">Agent Config Doctor <span id="app-version"></span></span>
      </div>
    </aside>

    <main class="workspace">
      <div class="session-error" id="session-error" role="alert" hidden></div>
      <div class="scan-notices" id="scan-notices" role="status" hidden></div>

      <section class="view" id="view-overview" data-view-panel="overview">
        <div class="view-heading">
          <div>
            <h1>Is my setup healthy here?</h1>
            <p>One summary per harness for <code id="overview-directory"></code>. Counts cover only what this directory loads or can call on. Everything else on disk is listed under Installed.</p>
          </div>
          <span class="scan-time" id="scan-time">Scanning</span>
        </div>
        <div class="empty-state" id="new-user-empty" hidden>
          <h2>Your local scan is ready</h2>
          <p>No supported agent configuration was discovered for this location. Add a provider instruction file or skill, then rerun Agent Config Doctor. Unavailable providers stay visible so the first scan still explains what was checked.</p>
          <code>agent-config-doctor scan . --json</code>
        </div>
        <div class="provider-summaries" id="overview-providers" aria-label="Provider summaries"></div>
        <section class="section-block" aria-labelledby="priority-heading">
          <div class="section-heading"><h2 id="priority-heading">Fix first</h2><a class="text-button" href="/findings" data-view="findings">View all findings</a></div>
          <div class="finding-list" id="priority-findings"></div>
        </section>
      </section>

      <section class="view" id="view-installed" data-view-panel="installed" hidden>
        <div class="view-heading">
          <div><h1>What configuration exists?</h1><p>Everything discovered on disk, grouped by who controls it. Discovered does not mean loaded: check Effective for what this directory uses.</p></div>
          <span class="result-count" id="inventory-count">0 resources</span>
        </div>
        <div class="filter-bar">
          <label class="search-field"><span>Search inventory</span><input id="inventory-search" type="search" placeholder="Name, path, owner, or source" autocomplete="off"></label>
          <label><span>Provider</span><select id="provider-filter"><option value="all">All providers</option></select></label>
          <label><span>Kind</span><select id="kind-filter"><option value="all">All kinds</option></select></label>
          <label><span>State</span><select id="state-filter"><option value="all">All states</option></select></label>
        </div>
        <div class="inventory-list" id="installed-groups"></div>
      </section>

      <section class="view" id="view-effective" data-view-panel="effective" hidden>
        <div class="view-heading">
          <div><h1>What will this harness use in this directory?</h1><p>Instructions load into context in this order. Skills wait until an agent calls them. Integrations run only when enabled.</p></div>
        </div>
        <div class="context-controls">
          <label><span>Provider</span><select id="effective-provider"></select></label>
          <div class="cwd-control"><span>Working directory</span><code id="working-directory"></code></div>
        </div>
        <p class="effective-summary" id="effective-summary"></p>
        <section class="section-block" aria-labelledby="effective-instructions-heading">
          <div class="section-heading"><h2 id="effective-instructions-heading">Loaded instructions</h2><span id="effective-instructions-count"></span></div>
          <div class="effective-list" id="effective-instructions"></div>
        </section>
        <section class="section-block" aria-labelledby="effective-skills-heading">
          <div class="section-heading"><h2 id="effective-skills-heading">Available skills</h2><span id="effective-skills-count"></span></div>
          <div class="effective-list" id="effective-skills"></div>
        </section>
        <section class="section-block" aria-labelledby="effective-integrations-heading">
          <div class="section-heading"><h2 id="effective-integrations-heading">Enabled integrations</h2><span id="effective-integrations-count"></span></div>
          <div class="effective-list" id="effective-integrations"></div>
        </section>
        <section class="section-block" aria-labelledby="effective-other-heading">
          <div class="section-heading"><h2 id="effective-other-heading">Not used here</h2><span id="effective-other-count"></span></div>
          <div class="effective-list" id="effective-other"></div>
        </section>
        <details class="collapsed-group" id="effective-elsewhere" hidden>
          <summary class="inventory-group-heading"><span>Elsewhere in repository</span><span id="effective-elsewhere-count"></span></summary>
          <p class="group-note">Found in this repository but outside the selected directory's ancestor chain. This harness does not use them here.</p>
          <div class="effective-list" id="effective-elsewhere-list"></div>
        </details>
      </section>

      <section class="view" id="view-findings" data-view-panel="findings" hidden>
        <div class="view-heading">
          <div><h1>What should I fix?</h1><p>Problems in files you control come first. Notes about provider-managed files and files elsewhere in the repository are collapsed below.</p></div>
          <span class="result-count" id="finding-count">0 findings</span>
        </div>
        <div class="finding-list" id="findings-actionable"></div>
        <details class="collapsed-group" id="findings-reference" hidden>
          <summary class="inventory-group-heading"><span>For reference</span><span id="findings-reference-count"></span></summary>
          <p class="group-note">Managed by a provider, plugin, package, or administrator. Shown so the scan is complete, not because you need to act.</p>
          <div class="finding-list" id="findings-reference-list"></div>
        </details>
        <details class="collapsed-group" id="findings-elsewhere" hidden>
          <summary class="inventory-group-heading"><span>Elsewhere in repository</span><span id="findings-elsewhere-count"></span></summary>
          <p class="group-note">These files sit outside the selected directory's ancestor chain and do not affect this directory.</p>
          <div class="finding-list" id="findings-elsewhere-list"></div>
        </details>
      </section>

      <section class="view" id="view-detail" data-view-panel="detail" hidden>
        <div class="view-heading detail-heading">
          <div><p class="view-kicker">What is this file and why does it matter?</p><h1 id="detail-title">Resource detail</h1><p id="detail-subtitle">Select a resource from Installed, Effective, or Findings.</p></div>
          <div class="action-row" id="resource-actions" hidden>
            <button type="button" id="copy-path">Copy path</button>
            <button type="button" id="reveal-resource">Reveal</button>
            <button class="primary-button" type="button" id="open-resource">Open in editor</button>
          </div>
        </div>
        <div class="detail-empty" id="detail-empty"><p>No resource selected yet.</p><a class="button-link" href="/installed" data-view="installed">Browse installed configuration</a></div>
        <div class="detail-layout" id="detail-content" hidden>
          <section class="detail-section detail-content-preview" id="detail-content-preview">
            <div class="section-heading"><h2>Content</h2><span id="preview-meta"></span></div>
            <p class="preview-warning">Shown exactly as written on disk inside this local session. File content may contain sensitive material such as internal names, hostnames, or credentials. Review it before sharing a screenshot. Exported JSON stays redacted.</p>
            <p class="preview-status" id="preview-status" hidden></p>
            <div class="preview-lines" id="preview-lines" role="region" aria-label="File content"></div>
          </section>
          <section class="detail-section detail-status"><h2>Effective status</h2><div id="detail-effective"></div></section>
          <section class="detail-section detail-validation"><h2>Validation</h2><div class="finding-list" id="detail-validation"></div></section>
          <section class="detail-section detail-metadata"><h2>Metadata</h2><dl id="detail-metadata"></dl></section>
          <section class="detail-section detail-provider">
            <details id="detail-provider-data"><summary>Redacted provider data</summary><pre id="detail-provider-json"></pre></details>
          </section>
          <section class="detail-section detail-raw-section">
            <details id="detail-raw"><summary>Raw JSON</summary><pre id="detail-raw-json"></pre></details>
          </section>
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
  --mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.45; }
button, input, select { font: inherit; }
button, select, summary { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.45; }
::selection { background: color-mix(in srgb, var(--accent) 38%, transparent); color: var(--inverse-text); }
* { scrollbar-color: var(--border-strong) var(--panel); scrollbar-width: thin; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
[hidden] { display: none !important; }
code { font-family: var(--mono); font-size: 0.93em; }

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
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  text-align: left;
  text-decoration: none;
  transition: background-color 160ms ease-out, color 160ms ease-out, border-color 160ms ease-out;
}
.nav-item:hover { color: var(--text); background: var(--panel-2); }
.nav-item.is-active { color: var(--text); background: var(--panel-2); border-color: var(--border); }
.nav-note { margin-top: auto; padding: 12px 10px 4px; display: grid; gap: 3px; color: var(--quiet); font-size: 11px; border-top: 1px solid var(--border); }
.nav-note-label { color: var(--muted); font-weight: 650; }
.nav-version { margin-top: 4px; font-variant-numeric: tabular-nums; }

.workspace { grid-area: workspace; min-width: 0; padding: 30px clamp(20px, 4vw, 54px) 56px; }
.view { width: min(1180px, 100%); margin: 0 auto; }
.view-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
.view-heading > div { min-width: 0; }
.view-heading h1 { margin: 0 0 5px; font-size: 21px; line-height: 1.2; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.view-heading p { max-width: 72ch; margin: 0; color: var(--muted); overflow-wrap: anywhere; }
.view-kicker { margin: 0 0 4px; color: var(--quiet); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.05em; }
.scan-time, .result-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }

.session-error { width: min(1180px, 100%); margin: 0 auto 20px; padding: 10px 12px; color: var(--error-text); background: color-mix(in srgb, var(--error) 9%, transparent); border: 1px solid color-mix(in srgb, var(--error) 35%, transparent); border-radius: 6px; }
.scan-notices { width: min(1180px, 100%); margin: 0 auto 20px; display: grid; gap: 8px; }
.scan-notice { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--warn) 8%, transparent); color: var(--text); }
.scan-notice strong { display: block; margin-bottom: 3px; color: var(--warn); font-size: 12px; }
.scan-notice p { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.scan-notice p + p { margin-top: 4px; }

.provider-summaries { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-bottom: 8px; }
.provider-card { min-width: 0; display: grid; gap: 10px; padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
.provider-card.is-unavailable { opacity: 0.72; }
.provider-card header { display: flex; align-items: center; gap: 10px; min-width: 0; }
.provider-name { min-width: 0; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-version { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.provider-card header .status-badge { margin-left: auto; }
.provider-counts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin: 0; }
.provider-counts > div { min-width: 0; display: grid; gap: 2px; }
.provider-counts dt { color: var(--muted); font-size: 11px; }
.provider-counts dd { margin: 0; font-size: 18px; font-weight: 680; line-height: 1.1; font-variant-numeric: tabular-nums; }
.provider-counts dd.is-attention { color: var(--warn); }
.provider-note { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.provider-note.is-warning { color: var(--warn); }
.provider-card .text-button { justify-self: start; }

.section-block { margin-top: 30px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 9px; }
.section-heading h2, .detail-section h2 { margin: 0; font-size: 13px; font-weight: 650; }
.section-heading > span { color: var(--quiet); font-size: 11px; font-variant-numeric: tabular-nums; }
.text-button { padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 12px; text-decoration: none; }
.text-button:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 3px; }

.finding-list, .effective-list, .inventory-list { border-top: 1px solid var(--border); }
.status-badge { flex: 0 0 auto; justify-self: start; padding: 2px 7px; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--muted); font-size: 10px; white-space: nowrap; }
.status-badge.active, .status-badge.supported { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: color-mix(in srgb, var(--ok) 7%, transparent); }
.status-badge.error, .status-badge.unavailable { color: var(--error); border-color: color-mix(in srgb, var(--error) 35%, transparent); background: color-mix(in srgb, var(--error) 7%, transparent); }
.status-badge.warning, .status-badge.unsupported, .status-badge.incomplete { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent); }
.status-badge.info { color: var(--info); border-color: color-mix(in srgb, var(--info) 35%, transparent); background: color-mix(in srgb, var(--info) 7%, transparent); }

.filter-bar, .context-controls { display: grid; grid-template-columns: minmax(240px, 1.5fr) repeat(3, minmax(130px, 0.65fr)); gap: 10px; margin-bottom: 20px; padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
.context-controls { grid-template-columns: minmax(180px, 0.6fr) minmax(280px, 1.4fr); }
.filter-bar label, .context-controls label, .context-controls .cwd-control { display: grid; gap: 5px; color: var(--muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.045em; }
.cwd-control code { display: flex; align-items: center; min-height: 34px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); font: 12px var(--mono); text-transform: none; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input, select { width: 100%; min-height: 34px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); outline: none; }
input::placeholder { color: var(--muted); }
input:hover, select:hover { border-color: var(--border-strong); }
input:focus, select:focus { border-color: var(--accent); }

.inventory-group, .collapsed-group { margin-bottom: 18px; }
.collapsed-group { margin-top: 26px; }
.inventory-group > summary, .collapsed-group > summary { list-style: none; }
.inventory-group > summary::-webkit-details-marker, .collapsed-group > summary::-webkit-details-marker { display: none; }
.inventory-group > summary::before, .collapsed-group > summary::before { content: "+"; display: inline-block; width: 14px; color: var(--quiet); }
.inventory-group[open] > summary::before, .collapsed-group[open] > summary::before { content: "-"; }
.inventory-group-heading { display: flex; align-items: baseline; gap: 6px; padding: 8px 3px; color: var(--muted); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.055em; }
.inventory-group-heading span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; }
.group-note { margin: 0 0 8px; padding: 0 3px; color: var(--quiet); font-size: 12px; }

.resource-row { width: 100%; display: grid; grid-template-columns: minmax(180px, 1.4fr) 90px 80px minmax(160px, 1fr) 132px; align-items: center; gap: 12px; min-height: 49px; padding: 8px 10px; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; color: var(--text); text-align: left; }
.resource-row:first-of-type { border-top: 1px solid var(--border); }
.resource-row:hover { background: var(--panel); }
.resource-row.is-selected { background: var(--panel-2); }
.resource-name { min-width: 0; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-kind, .resource-provider { color: var(--muted); font-size: 11px; text-transform: capitalize; }
.resource-path { min-width: 0; color: var(--quiet); font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.finding-card { min-width: 0; display: grid; gap: 8px; padding: 12px 10px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.finding-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.finding-title { min-width: 0; margin: 0; font-size: 14px; font-weight: 620; }
.finding-facts { display: grid; gap: 4px; margin: 0; }
.finding-facts > div, .finding-technical dl > div { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 4px 12px; }
.finding-facts dt { color: var(--muted); font-size: 12px; }
.finding-facts dd { min-width: 0; margin: 0; }
.finding-source { min-width: 0; max-width: 100%; padding: 0; border: 0; background: none; color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; text-align: left; }
.finding-source:not(:disabled):hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.finding-technical > summary { color: var(--quiet); font-size: 12px; list-style: none; }
.finding-technical > summary::-webkit-details-marker { display: none; }
.finding-technical > summary::before { content: "+ "; }
.finding-technical[open] > summary::before { content: "- "; }
.finding-technical dl { display: grid; gap: 4px; margin: 8px 0 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--inset); font-size: 12px; }
.finding-technical dt { color: var(--muted); }
.finding-technical dd { min-width: 0; margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }

.effective-summary { margin: 4px 0 6px; color: var(--muted); font-size: 12px; }
.effective-row { display: grid; grid-template-columns: 38px minmax(170px, 0.8fr) 132px minmax(220px, 1.5fr); gap: 12px; align-items: start; padding: 11px 8px; border-bottom: 1px solid var(--border); }
.effective-order { color: var(--quiet); font-variant-numeric: tabular-nums; text-align: right; }
.effective-name { min-width: 0; padding: 0; border: 0; background: none; color: var(--text); text-align: left; font-weight: 620; overflow-wrap: anywhere; }
.effective-name:hover { color: var(--accent); }
.effective-reason { min-width: 0; color: var(--muted); overflow-wrap: anywhere; }

button, .button-link { min-height: 32px; padding: 6px 11px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); text-decoration: none; transition: border-color 160ms ease-out, background-color 160ms ease-out, color 160ms ease-out; }
.button-link { display: inline-flex; align-items: center; }
button:hover:not(:disabled), .button-link:hover { border-color: var(--accent); }
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
.detail-validation, .detail-content-preview { grid-column: 1 / -1; }
.preview-warning { margin: 0 0 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--warn) 6%, transparent); color: var(--muted); font-size: 12px; }
.preview-status { margin: 0 0 10px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.preview-status.is-error { color: var(--error-text); }
.preview-lines { max-height: 480px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--inset); font: 12px/1.55 var(--mono); tab-size: 2; }
.preview-lines:empty { display: none; }
.preview-line { display: grid; grid-template-columns: 3.5em minmax(0, 1fr); }
.preview-number { padding: 0 8px; color: var(--quiet); text-align: right; user-select: none; }
.preview-text { min-width: 0; padding-right: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-line:hover { background: var(--panel); }
.detail-provider, .detail-raw-section { grid-column: 1 / -1; }
.detail-section details > summary { color: var(--muted); font-size: 13px; font-weight: 650; list-style: none; }
.detail-section details > summary::-webkit-details-marker { display: none; }
.detail-section details > summary::before { content: "+ "; color: var(--quiet); }
.detail-section details[open] > summary::before { content: "- "; }
.detail-section details > pre { margin-top: 10px; }
pre { max-height: 330px; margin: 0; padding: 14px 16px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--inset); color: var(--text); font: 12px/1.55 var(--mono); tab-size: 2; }
.effective-detail { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
.effective-detail-head { display: flex; align-items: center; gap: 10px; }
.effective-detail-head strong { font-weight: 620; }
.effective-detail p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
.detail-empty, .empty-state, .list-empty { padding: 28px; border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--muted); text-align: center; }
.detail-empty p { margin: 0 0 12px; }
.empty-state { margin-bottom: 30px; text-align: left; background: var(--panel); }
.empty-state h2 { margin: 0 0 7px; color: var(--text); font-size: 16px; }
.empty-state p { max-width: 72ch; margin: 0 0 14px; }
.empty-state code { display: inline-block; padding: 6px 9px; border-radius: 6px; background: var(--inset); color: var(--text); font-family: var(--mono); }

.toast { position: fixed; right: 20px; bottom: 20px; z-index: 20; max-width: min(380px, calc(100vw - 40px)); padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--panel-3); color: var(--text); box-shadow: 0 12px 32px color-mix(in srgb, var(--bg) 70%, transparent); opacity: 0; pointer-events: none; transform: translateY(8px); transition: opacity 180ms ease-out, transform 180ms ease-out; }
.toast.is-visible { opacity: 1; transform: translateY(0); }
.toast.is-error { border-color: color-mix(in srgb, var(--error) 55%, transparent); color: var(--error-text); }

@media (max-width: 920px) {
  .filter-bar { grid-template-columns: repeat(3, 1fr); }
  .search-field { grid-column: 1 / -1; }
  .resource-row { grid-template-columns: minmax(180px, 1fr) 90px 80px 132px; }
  .resource-path { display: none; }
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
  .provider-summaries { grid-template-columns: 1fr; }
  .context-controls, .filter-bar { grid-template-columns: 1fr; }
  .search-field { grid-column: auto; }
  .resource-row { grid-template-columns: minmax(0, 1fr) 70px 120px; }
  .resource-provider { display: none; }
  .resource-row .status-badge { justify-self: end; }
  .finding-facts > div, .finding-technical dl > div { grid-template-columns: 1fr; gap: 2px; }
  .finding-facts dt, .finding-technical dt { margin-top: 4px; }
  .effective-row { grid-template-columns: 30px minmax(0, 1fr) auto; }
  .effective-reason { grid-column: 2 / -1; }
  .detail-layout { grid-template-columns: 1fr; }
  .detail-section dl > div { grid-template-columns: 1fr; gap: 2px; }
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
  const routes = { overview: "/", installed: "/installed", effective: "/effective", findings: "/findings" };
  const resourceRoute = "/resources/";
  const credentialKey = "agent-config-doctor-credential";
  const relaunchMessage = "This tab has no local session credential. Relaunch Agent Config Doctor and open the URL it prints.";
  const state = {
    report: null,
    options: null,
    selectedResourceId: null,
    view: "overview",
    openGroups: new Set(["My configuration", "Administrator configuration"]),
    previewRequest: 0,
  };
  const actionEndpoints = {
    open: "/api/actions/open",
    reveal: "/api/actions/reveal",
  };
  const groupOrder = [
    "My configuration",
    "Administrator configuration",
    "Plugins",
    "Provider-managed",
    "Elsewhere in repository",
  ];
  const severityOrder = { error: 0, warning: 1, info: 2 };
  let toastTimer;
  let filterSyncTimer;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  // The credential arrives once in the URL fragment, moves into session
  // storage for this tab, and is stripped from the address bar. It is never
  // written to local storage or a cookie, so it dies with the tab.
  function credential() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const supplied = fragment.get("credential");
    if (supplied) {
      sessionStorage.setItem(credentialKey, supplied);
      history.replaceState(null, "", location.pathname + location.search);
      return supplied;
    }
    return sessionStorage.getItem(credentialKey);
  }

  let sessionCredential = credential();

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(endpoint, options = {}) {
    if (!sessionCredential) throw new ApiError(401, "unauthorized", relaunchMessage);
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + sessionCredential);
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(endpoint, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      sessionStorage.removeItem(credentialKey);
      sessionCredential = null;
      throw new ApiError(401, "unauthorized", relaunchMessage);
    }
    if (!response.ok) throw new ApiError(response.status, payload.error || "request_failed", payload.message || "The local dashboard request failed.");
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

  function ownerLabel(resource) {
    const owner = resource.owner;
    const base = owner.type === "self" ? "You"
      : owner.type === "provider" ? "Provider-managed" + " (" + providerLabel(owner.id || resource.provider) + ")"
      : owner.type === "plugin" ? "Plugin " + (owner.id || "unknown")
      : owner.type === "administrator" ? "Administrator"
      : "Package" + (owner.id ? " " + owner.id : "");
    return resource.generated ? base + ", generated copy" : base;
  }

  function inContext(item) {
    return item.reach !== "repository";
  }

  function contextResources() {
    return state.report.resources.filter(inContext);
  }

  function decisionFor(resource) {
    const effective = state.report.effective[resource.provider];
    return effective ? effective.decisions.find((decision) => decision.resourceId === resource.id) : undefined;
  }

  // Operator-facing status. One label answers "does this apply here?" without
  // asking the reader to combine state, reach, kind, and load mode.
  function operatorStatus(resource, decision) {
    if (!inContext(resource)) return { label: "Elsewhere in repository", tone: "" };
    const current = decision ? decision.state : resource.state;
    if (current === "active") {
      if (resource.kind === "instruction") return { label: "Loaded", tone: "active" };
      if (resource.kind === "skill") return { label: "Available on demand", tone: "active" };
      return { label: "Enabled", tone: "active" };
    }
    if (current === "unavailable") return { label: "Missing", tone: "error" };
    if (current === "blocked") return { label: "Blocked", tone: "error" };
    if (current === "invalid") return { label: "Invalid", tone: "error" };
    if (current === "disabled") return { label: "Disabled", tone: "warning" };
    if (current === "shadowed") return { label: "Shadowed", tone: "warning" };
    return { label: "Not loaded", tone: "" };
  }

  function statusBadge(status) {
    return element("span", "status-badge " + status.tone, status.label);
  }

  function badge(value) {
    return element("span", "status-badge " + value, value);
  }

  function groupFor(resource) {
    if (!inContext(resource)) return "Elsewhere in repository";
    const owner = resource.owner.type;
    if (resource.kind === "plugin" || owner === "plugin" || owner === "package") return "Plugins";
    if (owner === "administrator") return "Administrator configuration";
    if (owner === "provider" || resource.generated) return "Provider-managed";
    return "My configuration";
  }

  function isActionable(finding) {
    return finding.actionable === true && inContext(finding);
  }

  function sortFindings(findings) {
    return [...findings].sort((left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity]
      || (left.title || left.message).localeCompare(right.title || right.message)
      || left.code.localeCompare(right.code));
  }

  // Routing. Every page is a real URL served by the local process: pushState
  // moves between pages, popstate restores them, and only debounced filter
  // changes rewrite the current entry.
  function parseLocation() {
    const pathname = location.pathname;
    if (pathname.startsWith(resourceRoute)) {
      return { view: "detail", resourceId: pathname.slice(resourceRoute.length) };
    }
    const view = Object.keys(routes).find((name) => routes[name] === pathname) || "overview";
    return { view, resourceId: null };
  }

  function resourceLink(resource, className, text) {
    const link = element("a", className, text);
    link.href = resourceRoute + encodeURIComponent(resource.id);
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate(link.getAttribute("href"));
    });
    return link;
  }

  function navigate(path) {
    if (location.pathname + location.search === path) {
      applyLocation();
      return;
    }
    history.pushState(null, "", path);
    applyLocation();
  }

  function applyLocation() {
    const target = parseLocation();
    if (target.view === "detail") {
      if (!resourceById(target.resourceId)) {
        state.selectedResourceId = null;
        byId("detail-nav").hidden = true;
        byId("detail-empty").hidden = false;
        byId("detail-content").hidden = true;
        byId("resource-actions").hidden = true;
        byId("detail-title").textContent = "Resource not in this scan";
        byId("detail-subtitle").textContent = "The address names a resource that the current scan did not discover. Relaunch Agent Config Doctor if the file was added after the scan.";
        showView("detail");
        return;
      }
      state.selectedResourceId = target.resourceId;
      byId("detail-nav").hidden = false;
      byId("detail-nav").href = resourceRoute + encodeURIComponent(target.resourceId);
      renderDetail();
      renderInventory();
      showView("detail");
      return;
    }
    if (target.view === "installed") readFiltersFromLocation();
    if (target.view === "effective") readEffectiveProviderFromLocation();
    showView(target.view);
  }

  function showView(view) {
    state.view = view;
    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== view;
    });
    document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.view === view);
    });
    window.scrollTo(0, 0);
  }

  const filterFields = [["q", "inventory-search"], ["provider", "provider-filter"], ["kind", "kind-filter"], ["state", "state-filter"]];

  function readFiltersFromLocation() {
    const params = new URLSearchParams(location.search);
    for (const [key, id] of filterFields) {
      const field = byId(id);
      const value = params.get(key);
      if (field.tagName === "SELECT") {
        field.value = value && Array.from(field.options).some((option) => option.value === value) ? value : "all";
      } else {
        field.value = value || "";
      }
    }
    renderInventory();
  }

  function readEffectiveProviderFromLocation() {
    const provider = new URLSearchParams(location.search).get("provider");
    const select = byId("effective-provider");
    if (provider && Array.from(select.options).some((option) => option.value === provider)) select.value = provider;
    renderEffective();
  }

  function scheduleFilterSync() {
    clearTimeout(filterSyncTimer);
    filterSyncTimer = setTimeout(() => {
      const params = new URLSearchParams();
      if (state.view === "installed") {
        for (const [key, id] of filterFields) {
          const value = byId(id).value.trim();
          if (value && value !== "all") params.set(key, value);
        }
      } else if (state.view === "effective") {
        params.set("provider", byId("effective-provider").value);
      } else {
        return;
      }
      const search = params.toString();
      const next = routes[state.view] + (search ? "?" + search : "");
      if (location.pathname + location.search !== next) history.replaceState(null, "", next);
    }, 250);
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

  function providerSummary(provider) {
    const resources = contextResources().filter((resource) => resource.provider === provider.provider);
    const effective = state.report.effective[provider.provider];
    const activeIds = new Set((effective ? effective.decisions : []).filter((decision) => decision.state === "active").map((decision) => decision.resourceId));
    const count = (predicate) => resources.filter((resource) => activeIds.has(resource.id) && predicate(resource)).length;
    return {
      instructions: count((resource) => resource.kind === "instruction"),
      skills: count((resource) => resource.kind === "skill"),
      integrations: count((resource) => resource.kind === "mcp" || resource.kind === "plugin"),
      actionable: state.report.findings.filter((finding) => finding.provider === provider.provider && isActionable(finding)).length,
      notices: (state.report.notices || []).filter((notice) => notice.provider === provider.provider),
    };
  }

  function renderOverview() {
    const scannedAt = new Date(state.options.scannedAt);
    byId("scan-time").textContent = Number.isNaN(scannedAt.getTime())
      ? "Scan complete"
      : "Scanned " + scannedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    byId("header-context").textContent = state.report.subject.workingDirectory;
    byId("overview-directory").textContent = state.report.subject.workingDirectory;
    byId("new-user-empty").hidden = state.report.resources.length !== 0;

    const list = byId("overview-providers");
    list.replaceChildren();
    for (const provider of state.report.providers) {
      const card = element("article", "provider-card" + (provider.installed ? "" : " is-unavailable"));
      const head = element("header");
      head.append(
        element("span", "provider-name", providerLabel(provider.provider)),
        element("span", "provider-version", provider.installed ? provider.version : "not detected"),
        badge(provider.complete === false ? "incomplete" : provider.support),
      );
      card.append(head);
      if (provider.support === "supported") {
        const summary = providerSummary(provider);
        const counts = element("dl", "provider-counts");
        for (const [label, value, attention] of [
          ["Loaded instructions", summary.instructions, false],
          ["Available skills", summary.skills, false],
          ["Enabled integrations", summary.integrations, false],
          ["Actionable findings", summary.actionable, summary.actionable > 0],
        ]) {
          const item = element("div");
          const dd = element("dd", attention ? "is-attention" : "", value);
          item.append(element("dt", "", label), dd);
          counts.append(item);
        }
        card.append(counts);
        for (const notice of summary.notices) {
          card.append(element("p", "provider-note is-warning", "Scan incomplete: " + notice.command + " did not finish. See the notice above for how to rerun it."));
        }
        const link = element("a", "text-button", "View effective configuration");
        link.href = routes.effective + "?provider=" + encodeURIComponent(provider.provider);
        link.addEventListener("click", (event) => {
          event.preventDefault();
          navigate(link.getAttribute("href"));
        });
        card.append(link);
      } else {
        card.append(element("p", "provider-note", provider.support === "unsupported"
          ? "Installed version " + provider.version + " is not supported, so its configuration was not scanned."
          : "Not detected on this machine. Nothing was scanned for this provider."));
      }
      list.append(card);
    }

    const priority = byId("priority-findings");
    priority.replaceChildren();
    const actionable = sortFindings(state.report.findings.filter(isActionable));
    const reference = state.report.findings.filter((finding) => inContext(finding) && !isActionable(finding)).length;
    if (actionable.length === 0) {
      priority.append(element("div", "list-empty", reference > 0
        ? "Nothing needs your attention. " + plural(reference, "note is", "notes are") + " listed under Findings for reference."
        : "Nothing needs your attention."));
      return;
    }
    renderFindingsInto(priority, actionable.slice(0, 5));
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
    byId("inventory-count").textContent = plural(filtered.length, "resource") + (filtered.length === state.report.resources.length ? "" : " of " + state.report.resources.length);
    const list = byId("installed-groups");
    list.replaceChildren();
    if (filtered.length === 0) {
      list.append(element("div", "list-empty", state.report.resources.length === 0 ? "No local resources were discovered. The overview shows what was checked." : "No resources match these filters."));
      return;
    }

    const groups = new Map(groupOrder.map((label) => [label, []]));
    for (const resource of filtered) groups.get(groupFor(resource)).push(resource);
    for (const [label, resources] of groups) {
      if (resources.length === 0) continue;
      const group = element("details", "inventory-group");
      group.open = state.openGroups.has(label);
      group.addEventListener("toggle", () => {
        if (group.open) state.openGroups.add(label); else state.openGroups.delete(label);
      });
      const heading = element("summary", "inventory-group-heading");
      heading.append(element("span", "", label), element("span", "", plural(resources.length, "resource")));
      group.append(heading);
      for (const resource of resources) group.append(resourceRow(resource));
      list.append(group);
    }
  }

  function resourceRow(resource) {
    const row = resourceLink(resource, "resource-row" + (resource.id === state.selectedResourceId ? " is-selected" : ""));
    row.append(
      element("span", "resource-name", resource.name),
      element("span", "resource-provider", providerLabel(resource.provider)),
      element("span", "resource-kind", resource.kind),
      element("span", "resource-path", resource.displayPath || "No file path"),
      statusBadge(operatorStatus(resource, decisionFor(resource))),
    );
    return row;
  }

  function effectiveRow(resource, decision, order) {
    const row = element("div", "effective-row");
    row.append(element("span", "effective-order", order === undefined ? "" : String(order)));
    const reason = decision ? decision.reason : "Found outside the selected directory's ancestor chain.";
    row.append(resourceLink(resource, "effective-name", resource.name), statusBadge(operatorStatus(resource, decision)), element("span", "effective-reason", reason));
    return row;
  }

  function fillEffectiveSection(listId, countId, rows, emptyText) {
    const list = byId(listId);
    list.replaceChildren();
    byId(countId).textContent = plural(rows.length, "resource");
    if (rows.length === 0) {
      list.append(element("div", "list-empty", emptyText));
      return;
    }
    for (const row of rows) list.append(row);
  }

  function renderEffective() {
    const select = byId("effective-provider");
    const selectedProvider = select.value || (state.report.providers[0] && state.report.providers[0].provider);
    const effective = state.report.effective[selectedProvider];
    const label = providerLabel(selectedProvider);
    const provider = state.report.providers.find((item) => item.provider === selectedProvider);
    const elsewhere = state.report.resources.filter((resource) => resource.provider === selectedProvider && !inContext(resource));
    const elsewhereGroup = byId("effective-elsewhere");
    elsewhereGroup.hidden = elsewhere.length === 0;
    byId("effective-elsewhere-count").textContent = plural(elsewhere.length, "resource");
    const elsewhereList = byId("effective-elsewhere-list");
    elsewhereList.replaceChildren();
    for (const resource of elsewhere) elsewhereList.append(effectiveRow(resource, undefined));

    if (!effective || !provider || provider.support !== "supported") {
      byId("effective-summary").textContent = provider && provider.installed
        ? label + " " + provider.version + " is installed but not supported, so nothing was resolved for it."
        : label + " is not detected on this machine, so nothing was resolved for it.";
      fillEffectiveSection("effective-instructions", "effective-instructions-count", [], "No instructions were resolved.");
      fillEffectiveSection("effective-skills", "effective-skills-count", [], "No skills were resolved.");
      fillEffectiveSection("effective-integrations", "effective-integrations-count", [], "No integrations were resolved.");
      fillEffectiveSection("effective-other", "effective-other-count", [], "Nothing else was evaluated.");
      return;
    }

    const decisionById = new Map(effective.decisions.map((decision) => [decision.resourceId, decision]));
    const instructions = [];
    effective.orderedResourceIds.forEach((id, index) => {
      const resource = resourceById(id);
      const decision = decisionById.get(id);
      if (resource && decision && resource.kind === "instruction" && decision.state === "active") {
        instructions.push(effectiveRow(resource, decision, index + 1));
      }
    });
    const skills = [];
    const integrations = [];
    const other = [];
    for (const decision of effective.decisions) {
      const resource = resourceById(decision.resourceId);
      if (!resource) continue;
      if (decision.state === "active" && resource.kind === "skill") skills.push(effectiveRow(resource, decision));
      else if (decision.state === "active" && (resource.kind === "mcp" || resource.kind === "plugin")) integrations.push(effectiveRow(resource, decision));
      else if (decision.state !== "active" || resource.kind !== "instruction") other.push(effectiveRow(resource, decision));
    }
    byId("effective-summary").textContent = label + " loads " + plural(instructions.length, "instruction file") + ", can call on " + plural(skills.length, "skill") + ", and has " + plural(integrations.length, "integration") + " enabled for this directory.";
    fillEffectiveSection("effective-instructions", "effective-instructions-count", instructions, "No instruction files load for this directory.");
    fillEffectiveSection("effective-skills", "effective-skills-count", skills, "No skills are available on demand.");
    fillEffectiveSection("effective-integrations", "effective-integrations-count", integrations, "No MCP servers or plugins are enabled.");
    fillEffectiveSection("effective-other", "effective-other-count", other, "Every discovered resource for this directory is in use.");
  }

  function findingOwnerLabel(finding, resource) {
    if (resource) return ownerLabel(resource);
    if (finding.owner === "provider" || !finding.owner) return "Provider-managed" + " (" + providerLabel(finding.provider) + ")";
    return finding.owner;
  }

  function factRow(label, value) {
    const row = element("div");
    const dd = element("dd");
    if (value instanceof Node) dd.append(value); else dd.textContent = value;
    row.append(element("dt", "", label), dd);
    return row;
  }

  function findingCard(finding) {
    const resource = finding.resourceId ? resourceById(finding.resourceId) : null;
    const card = element("article", "finding-card");
    const head = element("div", "finding-head");
    head.append(badge(finding.severity), element("h3", "finding-title", finding.title || finding.message));
    card.append(head);

    const facts = element("dl", "finding-facts");
    facts.append(factRow("Impact", finding.impact || "Not classified."));
    facts.append(factRow("Owner", findingOwnerLabel(finding, resource)));
    const source = resource
      ? resourceLink(resource, "finding-source", resource.displayPath || resource.name)
      : element("span", "finding-source", providerLabel(finding.provider) + " (no single file)");
    facts.append(factRow("File", source));
    facts.append(factRow("Action", finding.remediation || "No guidance is available for this rule yet."));
    card.append(facts);

    const technical = element("details", "finding-technical");
    technical.append(element("summary", "", "Technical details"));
    const details = element("dl");
    details.append(
      factRow("Rule", finding.code),
      factRow("Confidence", finding.confidence),
      factRow("Evidence", finding.evidence || finding.message),
      factRow("Message", finding.message),
    );
    technical.append(details);
    card.append(technical);
    return card;
  }

  function renderFindingsInto(container, findings) {
    if (findings.length === 0) {
      container.append(element("div", "list-empty", "No findings in this view."));
      return;
    }
    for (const finding of findings) container.append(findingCard(finding));
  }

  function fillCollapsedFindings(groupId, listId, countId, findings) {
    const group = byId(groupId);
    group.hidden = findings.length === 0;
    byId(countId).textContent = plural(findings.length, "finding");
    const list = byId(listId);
    list.replaceChildren();
    if (findings.length > 0) renderFindingsInto(list, findings);
  }

  function renderFindings() {
    const actionable = sortFindings(state.report.findings.filter(isActionable));
    const reference = sortFindings(state.report.findings.filter((finding) => inContext(finding) && !isActionable(finding)));
    const elsewhere = sortFindings(state.report.findings.filter((finding) => !inContext(finding)));
    byId("finding-count").textContent = plural(actionable.length, "finding") + " to fix, " + plural(reference.length, "note") + " for reference" + (elsewhere.length > 0 ? ", " + elsewhere.length + " elsewhere in repository" : "");
    const list = byId("findings-actionable");
    list.replaceChildren();
    if (actionable.length === 0) {
      list.append(element("div", "list-empty", "Nothing in the files you control needs a fix for this directory."));
    } else {
      renderFindingsInto(list, actionable);
    }
    fillCollapsedFindings("findings-reference", "findings-reference-list", "findings-reference-count", reference);
    fillCollapsedFindings("findings-elsewhere", "findings-elsewhere-list", "findings-elsewhere-count", elsewhere);
  }

  function detailPair(label, value) {
    const row = element("div", "");
    row.append(element("dt", "", label), element("dd", "", value));
    return row;
  }

  function loadModeLabel(resource) {
    return ({ "context-loaded": "Loaded into context", "on-demand": "Available on demand", "explicitly-enabled": "Runs only when enabled" })[resource.loadMode] || "Unknown";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + " KiB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
  }

  function setPreviewStatus(message, isError) {
    const status = byId("preview-status");
    status.textContent = message;
    status.hidden = false;
    status.className = "preview-status" + (isError ? " is-error" : "");
  }

  // Previews are fetched per detail visit and never cached by the browser
  // (the server sends no-store). Configuration files never get raw previews.
  function renderPreview(resource) {
    const lines = byId("preview-lines");
    const meta = byId("preview-meta");
    lines.replaceChildren();
    meta.textContent = "";
    byId("preview-status").hidden = true;
    const request = ++state.previewRequest;
    if (!state.options.previewableResourceIds.includes(resource.id)) {
      setPreviewStatus(resource.kind === "instruction" || resource.kind === "skill"
        ? "No preview: this resource is not backed by a readable file inside the scanned roots."
        : "Configuration files are not previewed. The structured, redacted provider data below shows what was read from this file.", false);
      return;
    }
    setPreviewStatus("Loading file content.", false);
    api("/api/resources/" + encodeURIComponent(resource.id) + "/preview")
      .then((preview) => {
        if (request !== state.previewRequest) return;
        if (preview.empty) {
          setPreviewStatus("This file is empty.", false);
          meta.textContent = "0 B";
          return;
        }
        meta.textContent = plural(preview.lineCount, "line") + ", " + formatBytes(preview.size);
        if (preview.truncated) {
          setPreviewStatus("Showing the first " + formatBytes(preview.readBytes) + " of " + formatBytes(preview.size) + ". Open the file in an editor to read the rest.", false);
        } else {
          byId("preview-status").hidden = true;
        }
        const content = preview.content.endsWith("\n") ? preview.content.slice(0, -1) : preview.content;
        content.split("\n").forEach((text, index) => {
          const line = element("div", "preview-line");
          line.append(element("span", "preview-number", index + 1), element("span", "preview-text", text));
          lines.append(line);
        });
      })
      .catch((error) => {
        if (request !== state.previewRequest) return;
        const code = error instanceof ApiError ? error.code : "";
        const message = code === "resource_replaced" || code === "resource_missing"
          ? "The file changed or disappeared after the scan, so it is not previewed. Relaunch Agent Config Doctor to rescan."
          : code === "preview_too_large"
            ? "This file is larger than 1 MiB and is not previewed. Open it in an editor instead."
            : code === "preview_not_text"
              ? "This file is not UTF-8 text, so no preview is shown."
              : error instanceof Error ? error.message : "The preview could not be loaded.";
        setPreviewStatus(message, true);
        if (error instanceof ApiError && error.status === 401) showError(error);
      });
  }

  function renderDetail() {
    const resource = resourceById(state.selectedResourceId);
    if (!resource) return;
    byId("detail-title").textContent = resource.name;
    byId("detail-subtitle").textContent = providerLabel(resource.provider) + " " + resource.kind + " at " + (resource.displayPath || "a non-file source");
    byId("detail-empty").hidden = true;
    byId("detail-content").hidden = false;

    renderPreview(resource);

    const decision = decisionFor(resource);
    const status = operatorStatus(resource, decision);
    const effective = byId("detail-effective");
    const panel = element("div", "effective-detail");
    const head = element("div", "effective-detail-head");
    head.append(statusBadge(status), element("strong", "", status.label + " for " + providerLabel(resource.provider) + " in " + state.report.subject.workingDirectory));
    panel.append(head);
    panel.append(element("p", "", decision
      ? decision.reason + (decision.order === undefined ? "" : " Position " + (decision.order + 1) + " in the load order.")
      : inContext(resource)
        ? "This resource was not part of the effective configuration for this directory."
        : "Found in the repository outside the selected directory's ancestor chain, so it is never loaded here."));
    panel.append(element("p", "", loadModeLabel(resource) + ". Controlled by " + ownerLabel(resource).replace(/^You$/, "you") + "."));
    effective.replaceChildren(panel);

    const validation = byId("detail-validation");
    validation.replaceChildren();
    const findings = sortFindings(state.report.findings.filter((finding) => finding.resourceId === resource.id));
    if (findings.length === 0) {
      validation.append(element("div", "list-empty", "No findings for this resource."));
    } else {
      renderFindingsInto(validation, findings);
    }

    const metadata = byId("detail-metadata");
    metadata.replaceChildren(
      detailPair("Provider", providerLabel(resource.provider) + " " + resource.providerVersion),
      detailPair("Kind", resource.kind),
      detailPair("Scope", resource.scope),
      detailPair("Owner", ownerLabel(resource)),
      detailPair("Origin", resource.origin),
      detailPair("Reach", inContext(resource) ? "In the selected directory's ancestor chain" : "Elsewhere in repository"),
      detailPair("Load mode", loadModeLabel(resource)),
      detailPair("Raw state", resource.state),
      detailPair("Evidence", resource.evidenceType + ": " + resource.evidenceReceipt),
      detailPair("Source", resource.displayPath || "Not file-backed"),
    );
    byId("detail-provider-json").textContent = JSON.stringify({ precedence: resource.precedence, capabilities: resource.capabilities, metadata: resource.metadata }, null, 2);
    byId("detail-raw-json").textContent = JSON.stringify(resource, null, 2);
    byId("detail-provider-data").open = false;
    byId("detail-raw").open = false;

    const actionable = state.options.actionableResourceIds.includes(resource.id);
    byId("resource-actions").hidden = !actionable;
    byId("open-resource").disabled = !state.options.editor;
    byId("open-resource").title = state.options.editor ? "Open in " + state.options.editor.label : "No supported GUI editor detected";
  }

  function renderControls() {
    const providerSelect = byId("effective-provider");
    const previousProvider = providerSelect.value;
    fillSelect(providerSelect, state.report.providers.map((provider) => ({ value: provider.provider, label: providerLabel(provider.provider) })), null);
    // Default to the first supported provider so the page opens on a harness
    // that actually resolved something, not on whichever adapter sorts first.
    const firstSupported = state.report.providers.find((provider) => provider.support === "supported");
    if (previousProvider && state.report.effective[previousProvider]) providerSelect.value = previousProvider;
    else if (firstSupported) providerSelect.value = firstSupported.provider;
    byId("working-directory").textContent = state.options.workingDirectory;
    byId("app-version").textContent = state.options.version ? "v" + state.options.version : "";
  }

  function renderAll() {
    renderNotices();
    renderOverview();
    renderFilters();
    renderInventory();
    renderControls();
    renderEffective();
    renderFindings();
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
      if (error instanceof ApiError && error.status === 401) showError(error);
    }
  }

  document.querySelectorAll("[data-view]").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      if (!state.report) return;
      navigate(item.getAttribute("href"));
    });
  });
  for (const [, id] of filterFields) {
    byId(id).addEventListener(id === "inventory-search" ? "input" : "change", () => {
      renderInventory();
      scheduleFilterSync();
    });
  }
  byId("effective-provider").addEventListener("change", () => {
    renderEffective();
    scheduleFilterSync();
  });
  byId("copy-path").addEventListener("click", () => resourceAction("copy"));
  byId("reveal-resource").addEventListener("click", () => resourceAction("reveal"));
  byId("open-resource").addEventListener("click", () => resourceAction("open"));
  window.addEventListener("popstate", () => {
    if (state.report) applyLocation();
  });

  Promise.all([api("/api/scan"), api("/api/options")])
    .then(([report, options]) => {
      state.report = report;
      state.options = options;
      renderAll();
      applyLocation();
    })
    .catch(showError);
})();
`;
