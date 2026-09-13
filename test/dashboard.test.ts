import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dashboardClientScript,
  dashboardDocument,
  dashboardStyles,
} from "../src/dashboard/dashboard.ts";

test("dashboard document answers one operator question per page and keeps the design contract", () => {
  const document = dashboardDocument();

  assert.match(document, /<body>\s*<!--\s*THESIS:/);
  for (const view of ["Overview", "Installed", "Effective", "Findings", "Resource detail"]) {
    assert.match(document, new RegExp(`>${view}<`));
  }
  for (const question of [
    "Is my setup healthy here?",
    "What configuration exists?",
    "What will this harness use in this directory?",
    "What should I fix?",
    "What is this file and why does it matter?",
  ]) {
    assert.ok(document.includes(question), `missing page question: ${question}`);
  }

  // Overview: one summary per provider, no global vanity total.
  assert.match(document, /id="overview-providers"/);
  assert.equal(document.includes('id="summary-resources"'), false);
  assert.equal(document.includes("resources in this context"), false);
  assert.equal(document.includes('id="kind-breakdown"'), false);

  // Installed: ownership groups with preserved counts, filters intact.
  assert.match(document, /id="installed-groups"/);
  assert.match(document, /id="inventory-search"/);
  assert.match(document, /id="provider-filter"/);
  assert.match(document, /id="kind-filter"/);
  assert.match(document, /id="state-filter"/);

  // Effective: loaded instructions, available skills, enabled integrations, collapsed elsewhere.
  assert.match(document, /id="effective-provider"/);
  assert.match(document, /<code id="working-directory">/);
  assert.equal(document.includes('<select id="working-directory">'), false);
  assert.match(document, /id="effective-instructions"/);
  assert.match(document, /id="effective-skills"/);
  assert.match(document, /id="effective-integrations"/);
  assert.match(document, /id="effective-other"/);
  assert.match(document, /<details[^>]+id="effective-elsewhere"/);

  // Findings: actionable first, reference and elsewhere collapsed.
  assert.match(document, /id="findings-actionable"/);
  assert.match(document, /<details[^>]+id="findings-reference"/);
  assert.match(document, /<details[^>]+id="findings-elsewhere"/);

  // Detail: full-width validation, actions, metadata, collapsed provider data and raw JSON.
  assert.match(document, /id="detail-effective"/);
  assert.match(document, /id="detail-validation"/);
  assert.match(document, /id="detail-metadata"/);
  assert.match(document, /<details[^>]+id="detail-provider-data"/);
  assert.match(document, /<details[^>]+id="detail-raw"/);
  assert.match(document, /id="copy-path"/);
  assert.match(document, /id="reveal-resource"/);
  assert.match(document, /id="open-resource"/);
  assert.match(document, /class="brand"[^>]+data-view="overview"/);
  assert.equal(document.includes("credential="), false);
});

test("dashboard uses the incumbent restrained dark system and responsive structure", () => {
  assert.match(dashboardStyles, /--bg:\s*#0f1115/);
  assert.match(dashboardStyles, /--panel:\s*#171a21/);
  assert.match(dashboardStyles, /--accent:\s*#d97757/);
  assert.match(dashboardStyles, /@media \(max-width: 760px\)/);
  assert.match(dashboardStyles, /:focus-visible/);
  assert.match(dashboardStyles, /::selection/);
  assert.match(dashboardStyles, /prefers-reduced-motion/);
});

test("finding cards and the detail validation section cannot squeeze text to zero width", () => {
  // The old five-column finding grid collapsed its message column. Findings
  // are stacked cards whose text column always keeps a minimum of zero-safe
  // flexible width and wraps long values.
  assert.equal(dashboardStyles.includes("grid-template-columns: 76px 92px 110px"), false);
  assert.match(dashboardStyles, /\.finding-card\s*\{[^}]*min-width:\s*0/);
  assert.match(dashboardStyles, /\.finding-card[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(dashboardStyles, /\.detail-validation[^{]*\{[^}]*grid-column:\s*1 \/ -1/);
});

test("dashboard client translates the data model into operator labels and groups", () => {
  for (const label of [
    "Loaded",
    "Available on demand",
    "Enabled",
    "Elsewhere in repository",
    "Missing",
    "Blocked",
    "My configuration",
    "Administrator configuration",
    "Plugins",
    "Provider-managed",
    "Technical details",
  ]) {
    assert.ok(dashboardClientScript.includes(`"${label}"`), `missing label: ${label}`);
  }
  assert.match(dashboardClientScript, /finding\.title/);
  assert.match(dashboardClientScript, /finding\.impact/);
  assert.match(dashboardClientScript, /finding\.remediation/);
  assert.match(dashboardClientScript, /finding\.actionable/);
});

test("dashboard navigates with real routes and restores them from history", () => {
  assert.match(dashboardClientScript, /history\.pushState/);
  assert.match(dashboardClientScript, /addEventListener\("popstate"/);
  // replaceState is reserved for stripping the credential fragment and for
  // debounced filter changes; view changes never replace history entries.
  assert.equal((dashboardClientScript.match(/history\.replaceState/g) ?? []).length, 2);
  assert.match(dashboardClientScript, /filterSyncTimer = setTimeout\([\s\S]{0,800}?history\.replaceState/);
  for (const route of ['"/installed"', '"/effective"', '"/findings"', '"/resources/"']) {
    assert.ok(dashboardClientScript.includes(route), `missing route: ${route}`);
  }
  const document = dashboardDocument();
  assert.match(document, /href="\/installed"/);
  assert.match(document, /href="\/effective"/);
  assert.match(document, /href="\/findings"/);
  assert.equal(document.includes('href="#'), false);
});

test("dashboard keeps the credential in session storage and clears it on 401", () => {
  assert.match(dashboardClientScript, /credentialKey = "agent-config-doctor-credential"/);
  assert.match(dashboardClientScript, /sessionStorage\.setItem\(credentialKey/);
  assert.match(dashboardClientScript, /sessionStorage\.removeItem\(credentialKey/);
  assert.match(dashboardClientScript, /status === 401/);
  assert.match(dashboardClientScript, /Relaunch Agent Config Doctor/);
  assert.equal(dashboardClientScript.includes("localStorage"), false);
  assert.equal(dashboardClientScript.includes("document.cookie"), false);
});

test("dashboard previews instruction and skill text with a privacy warning and explicit states", () => {
  const document = dashboardDocument();
  assert.match(document, /id="detail-content-preview"/);
  assert.match(document, /id="preview-lines"/);
  assert.match(document, /id="preview-status"/);
  assert.match(document, /may contain sensitive material/);
  assert.match(document, /before sharing a screenshot/);
  assert.match(dashboardClientScript, /\/preview"/);
  assert.match(dashboardClientScript, /previewableResourceIds/);
  for (const state of ["empty", "truncated", "preview_too_large", "preview_not_text", "resource_replaced"]) {
    assert.ok(dashboardClientScript.includes(state), `missing preview state: ${state}`);
  }
  assert.match(dashboardStyles, /\.preview-text\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(dashboardStyles, /\.preview-text\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test("dashboard renders scan values as text and authenticates every API request", () => {
  assert.equal(dashboardClientScript.includes("innerHTML"), false);
  assert.match(dashboardClientScript, /textContent/);
  assert.match(dashboardClientScript, /Authorization/);
  assert.match(dashboardClientScript, /sessionStorage/);
  assert.equal(dashboardClientScript.includes("localStorage"), false);
  assert.match(dashboardClientScript, /api\/resources\/.*\/path/);
  assert.match(dashboardClientScript, /api\/actions\/open/);
  assert.match(dashboardClientScript, /api\/actions\/reveal/);
});
