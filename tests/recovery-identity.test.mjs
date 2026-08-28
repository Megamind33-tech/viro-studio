/**
 * VIRO-0011 DRAFT — document-identity recovery model (unit level).
 * Uncommitted prep draft: encodes the TARGET API and is expected RED on
 * current main (single-slot "current" recovery). Do not treat as a gate.
 *
 * Design under test (built on VIRO-0010 seams — announce(), recoverySink,
 * shared per-tick snapshot):
 *  - Every working document gets a stable identity: the current project id
 *    (`proj_*`), minted on first autosave if absent (ensureDocIdentity).
 *  - Recovery records are keyed by that identity in the SAME IndexedDB store
 *    (keyPath "id" is already generic) — no DB version bump, no format change.
 *  - Sequentially edited documents keep independent snapshots.
 *  - restoreRecovery(id) preserves project identity (fixes critic P3-2);
 *    legacy "current" records restore under a freshly minted project id.
 *  - Deleting a project also deletes its recovery record, so a deleted
 *    document can never resurrect through the recovery path.
 *  - No-arg restore/discard act on the prompted (newest) record, keeping the
 *    existing recover-bar handlers and tests/recovery.spec.mjs semantics.
 *
 *   node --experimental-transform-types --import ./tests/ts-register.mjs --test tests/recovery-identity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PressApp } from "../src/app.ts";
import { setFlag, resetFlags } from "../src/platform/flags.ts";

function makeApp() {
  const app = new PressApp();
  app.booted = true;
  return app;
}

function edit(app, x = 10) {
  const ok = app.run(
    {
      type: "vector.addRect",
      params: { x, y: 10, w: 50, h: 50, fill: { r: 1, g: 0.5, b: 0, a: 1 } },
    },
    { label: "recovery-identity test edit" },
  );
  assert.equal(ok, true, "test edit must apply");
}

function disarm(app) {
  if (app.autosaveTimer) {
    clearTimeout(app.autosaveTimer);
    app.autosaveTimer = 0;
  }
}

/** Sink-captured recovery records, as the store would hold them. */
function captureSink(app) {
  const records = new Map();
  app.recoverySink = async (snapshot) => {
    records.set(snapshot.id, snapshot);
  };
  return records;
}

test("two documents edited in sequence keep independent recovery snapshots", async () => {
  resetFlags();
  setFlag("platform.enabled", false); // unit level: isolation from the project store
  const app = makeApp();
  const records = captureSink(app);

  edit(app, 10);
  await app.writeRecovery();
  const idA = app.currentProjectId;
  assert.match(idA, /^proj_/, "first autosave mints a stable project identity");
  assert.equal(records.size, 1);

  // A second document: a fresh project identity, its own edits, its own record.
  await app.newProject();
  edit(app, 500);
  await app.writeRecovery();
  const idB = app.currentProjectId;
  disarm(app);
  assert.match(idB, /^proj_/);
  assert.notEqual(idA, idB, "each document owns its identity");
  assert.equal(records.size, 2, "two records exist");
  assert.equal(records.get(idA).doc.pages[0].layers.length, 1, "A's snapshot survived B's autosave");
  assert.equal(records.get(idB).doc.pages[0].layers.length, 1, "B has its own snapshot");
  assert.notEqual(
    JSON.stringify(records.get(idA).doc),
    JSON.stringify(records.get(idB).doc),
    "snapshots are independent, not clobbered",
  );
});

test("restoreRecovery(id) preserves the project identity (critic P3-2)", async () => {
  resetFlags();
  setFlag("platform.enabled", false);
  const app = makeApp();
  const records = captureSink(app);
  edit(app, 10);
  await app.writeRecovery();
  const idA = app.currentProjectId;
  disarm(app);

  // A later session: nothing loaded, identity lost in memory.
  const fresh = makeApp();
  fresh.pendingRecoveries = [records.get(idA)];
  fresh.pendingRecovery = records.get(idA);
  assert.equal(fresh.restoreRecovery(idA), true);
  disarm(fresh);
  assert.equal(fresh.currentProjectId, idA, "restore adopts the record's project identity");
  assert.equal(fresh.doc.pages[0].layers.length, 1, "restored content matches the record");
});

test("a legacy 'current' record restores under a freshly minted project id", async () => {
  resetFlags();
  setFlag("platform.enabled", false);
  const app = makeApp();
  const legacy = {
    id: "current",
    doc: { pages: [{ layers: [] }], name: "legacy" },
    name: "legacy",
    savedAt: Date.now() - 1000,
  };
  app.pendingRecoveries = [legacy];
  app.pendingRecovery = legacy;
  // No-arg restore acts on the prompted (newest) record — back-compat with
  // the existing recover-bar handlers and tests/recovery.spec.mjs.
  assert.equal(app.restoreRecovery(), true);
  disarm(app);
  assert.match(app.currentProjectId, /^proj_/, "legacy slot identity is never adopted as a project id");
  assert.notEqual(app.currentProjectId, "current");
});

test("deleting the open project's identity never resurrects it (identity is not reused)", async () => {
  resetFlags();
  setFlag("platform.enabled", false);
  const app = makeApp();
  const records = captureSink(app);
  edit(app, 10);
  await app.writeRecovery();
  const idA = app.currentProjectId;
  disarm(app);

  // Simulate the post-delete state produced by deleteProject(id): the project
  // AND its recovery record are gone (the real deleteProject also calls
  // deleteRecovery(id) — proven against real IndexedDB in the .spec E2E).
  records.delete(idA);
  app.currentProjectId = null;
  edit(app, 700);
  await app.writeRecovery();
  disarm(app);
  const newId = app.currentProjectId;
  assert.notEqual(newId, idA, "a deleted document's identity is never reused");
  assert.equal(records.has(idA), false, "no resurrection of the deleted identity");
  assert.equal(records.size, 1);
});

test("pendingRecovery stays the newest pending record (recover-bar contract)", async () => {
  resetFlags();
  setFlag("platform.enabled", false);
  const older = { id: "proj_a", doc: { pages: [{ layers: [] }], name: "a" }, name: "a", savedAt: 1000 };
  const newer = { id: "proj_b", doc: { pages: [{ layers: [] }], name: "b" }, name: "b", savedAt: 2000 };
  const app = makeApp();
  app.pendingRecoveries = [newer, older];
  app.pendingRecovery = newer;
  app.discardRecovery(newer.id);
  assert.equal(app.pendingRecovery, older, "after discarding the head, the bar shows the next record");
  disarm(app);
});
