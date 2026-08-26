import "./chrome/desk.css";
import { PressApp } from "./app";
import { mountDesk } from "./chrome/desk";
import { mountAnchorPanel } from "./chrome/anchor-panel";
import "./chrome/controls";
import {
  ANCHOR_CONTRACT,
  ANCHOR_OP_NAMES,
  ANCHOR_TOOLS,
  type AnchorOp,
} from "./anchor/tools";

const boot = document.getElementById("boot")!;
const statusEl = document.getElementById("bootStatus");
const desk = document.getElementById("desk")!;

const app = new PressApp();
app.onChange(() => {
  if (statusEl) statusEl.textContent = app.status;
});

const canvas = mountDesk(desk, app);

/**
 * The Anchor studio populates the docked `#g-anchor` panel that index.html
 * already declares — the catalogue, the composer, the JSON entry, and the op
 * queue that is also the audit trail. It drives `applyAnchorDetailed`, so the
 * panel and a cold-calling model go through exactly the same path.
 */
mountAnchorPanel(app);

/**
 * The Anchor surface. A model calling in cold needs three things: the op
 * schemas, the contract that governs the envelope (units, colour ranges, the
 * mandatory `reason`), and a reply that says what each op actually did.
 * `apply` stays void for existing callers; `applyDetailed` returns the audit
 * trail — per-op summary, reason, and the ids of anything created — which is
 * what the queue surface and a follow-up batch both need.
 */
const api = {
  tools: ANCHOR_TOOLS,
  contract: ANCHOR_CONTRACT,
  opNames: ANCHOR_OP_NAMES,
  apply: (ops: unknown) => {
    app.applyAnchor(ops as AnchorOp[]);
  },
  applyDetailed: (ops: unknown) => app.applyAnchorDetailed(ops as AnchorOp[]),
  /**
   * Report exactly what a batch WOULD do — per-op summaries, the layers it
   * would create, the resulting selection — without applying it or touching
   * history. Preview and execution share one code path in the command bus, so
   * what this reports is what execution actually does.
   */
  preview: (ops: unknown) => app.previewAnchor(ops as AnchorOp[]),
  results: () => app.anchorResults,
  document: () => app.doc,
};

(window as Window & { viroAnchor?: typeof api; __press?: PressApp }).viroAnchor = api;
(window as Window & { __press?: PressApp }).__press = app;

app
  .boot(canvas)
  .then(() => {
    boot.classList.add("gone");
    desk.hidden = false;
  })
  .catch((err) => {
    if (statusEl) statusEl.textContent = String(err);
    throw err;
  });
