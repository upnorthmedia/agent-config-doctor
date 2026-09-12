import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dashboardClientScript,
  dashboardDocument,
  dashboardStyles,
} from "../src/dashboard/dashboard.ts";

test("dashboard document exposes every Phase 3 view and keeps the design contract", () => {
  const document = dashboardDocument();

  assert.match(document, /<body>\s*<!--\s*THESIS:/);
  for (const view of [
    "Overview",
    "Installed inventory",
    "Effective config",
    "Findings",
    "Resource detail",
  ]) {
    assert.match(document, new RegExp(`>${view}<`));
  }
  assert.match(document, /id="inventory-search"/);
  assert.match(document, /id="provider-filter"/);
  assert.match(document, /id="kind-filter"/);
  assert.match(document, /id="state-filter"/);
  assert.match(document, /id="effective-provider"/);
  assert.match(document, /<code id="working-directory">/);
  assert.equal(document.includes('<select id="working-directory">'), false);
  assert.match(document, /id="copy-path"/);
  assert.match(document, /id="reveal-resource"/);
  assert.match(document, /id="open-resource"/);
  assert.match(document, /class="brand"[^>]+data-view="overview"/);
  assert.match(document, /id="kind-breakdown"/);
  assert.match(document, /id="state-breakdown"/);
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

test("dashboard renders scan values as text and authenticates every API request", () => {
  assert.equal(dashboardClientScript.includes("innerHTML"), false);
  assert.match(dashboardClientScript, /textContent/);
  assert.match(dashboardClientScript, /Authorization/);
  assert.match(dashboardClientScript, /sessionStorage/);
  assert.match(dashboardClientScript, /api\/resources\/.*\/path/);
  assert.match(dashboardClientScript, /api\/actions\/open/);
  assert.match(dashboardClientScript, /api\/actions\/reveal/);
  assert.equal(dashboardClientScript.includes("select-working-directory"), false);
  assert.match(dashboardClientScript, /Elsewhere in repository/);
  assert.match(dashboardClientScript, /reach !== "repository"/);
});
