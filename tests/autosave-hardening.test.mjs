/**
 * Autosave quota / write-failure hardening (packet VIRO-0010).
 *
 * Before-state (GOVERNOR.md Active Risks + docs/reviews/sprint-critic-01.md
 * P2-3): an autosave tick deep-cloned the whole document (embedded image
 * dataURLs included) once per persistence sink, and any IndexedDB write
 * failure — quota, private mode, IO — was swallowed silently, so the UI gave
 * no sign the safety net was gone.
 *
 * Contract proven here:
 *  1. A failed recovery write leaves the last good snapshot intact and it
 *     stays recoverable through the existing recovery path.
 *  2. Failures announce a truthful status — no silent fake success.
 *  3. An autosave tick performs AT MOST ONE whole-document serialization,
 *     shared between both sinks (measured by counting JSON.stringify calls
 *     that receive the live document reference).
 *
 * Runs against the real PressApp in node. Node has no `indexedDB`, so the
 * real store writes reject naturally — the same rejection path a browser
 * hits on quota/private-mode errors.
 *
 *   node --experimental-transform-types --import ./tests/ts-register.mjs --test tests/autosave-hardening.test.mjs
 *
 * (--experimental-transform-types, not strip-only: src/app.ts's import graph
 * uses TypeScript parameter properties, which strip-only mode cannot load.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PressApp } from "../src/app.ts";

/** A fresh app with boot tracking on, so edits mark it dirty. */
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
    { label: "autosave-hardening test edit" },
  );
  assert.equal(ok, true, "test edit must apply");
}

/** Count whole-document serializations: stringify calls receiving the LIVE doc reference. */
function countDocClones(app) {
  const original = JSON.stringify;
  let count = 0;
  JSON.stringify = function (value, ...rest) {
    if (value === app.doc) count++;
    return original.call(JSON, value, ...rest);
  };
  return {
    get count() {
      return count;
    },
    restore() {
      JSON.stringify = original;
    },
  };
}

/** Clear any debounce timer a test left armed so the process ends promptly. */
function disarm(app) {
  if (app.autosaveTimer) {
    clearTimeout(app.autosaveTimer);
    app.autosaveTimer = 0;
  }
}

const QUOTA_ERR = Object.assign(new Error("simulated quota exceeded"), {
  name: "QuotaExceededError",
});

test("a successful autosave stores the plain document snapshot (public signature intact)", async () => {
  const app = makeApp();
  edit(app);
  const stored = [];
  app.recoverySink = async (snapshot) => {
    stored.push(snapshot);
  };
  await app.writeRecovery();
  disarm(app);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "current");
  assert.deepEqual(stored[0].doc, JSON.parse(JSON.stringify(app.doc)));
  assert.equal(app.dirty, false, "a durable write clears the dirty flag");
  assert.doesNotMatch(app.status, /failed/i);
});

test("a failed recovery write keeps the last good snapshot, announces truthfully, and stays recoverable", async () => {
  const app = makeApp();
  edit(app, 10);
  const good = [];
  app.recoverySink = async (snapshot) => {
    good.push(snapshot);
  };
  await app.writeRecovery();
  const goodSnapshot = good[0];
  const savedRevAfterGoodWrite = app.savedRev;
  assert.equal(goodSnapshot.doc.pages[0].layers.length, 1);

  // Storage starts failing (quota / private mode / IO).
  let failedCalls = 0;
  app.recoverySink = async () => {
    failedCalls++;
    throw QUOTA_ERR;
  };
  edit(app, 200); // new unsaved work on top of the good snapshot

  await assert.doesNotReject(() => app.writeRecovery(), "failure is handled, never thrown into the edit path");
  disarm(app);
  assert.equal(failedCalls, 1, "the failing sink was used");
  assert.equal(good.length, 1, "the failed tick must not replace the stored snapshot");
  assert.match(app.status, /Autosave failed/i);
  assert.match(app.status, /simulated quota exceeded/);
  assert.doesNotMatch(app.status, /saved|recovered|stored to/i, "no fake success wording");
  assert.equal(app.dirty, true, "unsaved work stays dirty so a later write retries");
  assert.equal(app.savedRev, savedRevAfterGoodWrite, "savedRev still points at the last DURABLE write");

  // The existing recovery path still restores exactly the last good snapshot.
  app.pendingRecovery = goodSnapshot;
  assert.equal(app.restoreRecovery(), true);
  assert.equal(app.doc.pages[0].layers.length, 1, "restored to the last GOOD state, not the failed one");
  assert.match(app.status, /Recovered/);
});

test("a failed write does not re-arm the autosave timer (no retry storm on a large document)", async () => {
  const app = makeApp();
  edit(app);
  app.recoverySink = async () => {
    throw QUOTA_ERR;
  };
  app.autosaveTimer = 0; // simulate the moment the debounced tick fires
  await app.writeRecovery();
  disarm(app);
  assert.equal(app.autosaveTimer, 0, "announce() must not re-enter trackRevision and re-arm autosave");
});

test("an autosave tick with a failing recovery write serializes the document at most ONCE", async () => {
  const app = makeApp();
  edit(app);
  app.recoverySink = async () => {
    throw QUOTA_ERR;
  };
  const counter = countDocClones(app);
  try {
    await app.autosaveTick(); // private, but runtime-callable from tests
  } finally {
    counter.restore();
    disarm(app);
  }
  assert.ok(counter.count <= 1, `expected at most one whole-doc clone per tick, got ${counter.count}`);
  assert.match(app.status, /Autosave failed/i, "recovery failure is announced");
  assert.match(app.status, /Project autosave failed/i, "the project sink failure is also announced, not silent");
  assert.equal(app.dirty, true, "both sinks failed: work stays dirty for retry");
});

test("an autosave tick with a successful recovery write serializes the document at most ONCE", async () => {
  const app = makeApp();
  edit(app);
  const stored = [];
  app.recoverySink = async (snapshot) => {
    stored.push(snapshot);
  };
  const counter = countDocClones(app);
  try {
    await app.autosaveTick();
  } finally {
    counter.restore();
    disarm(app);
  }
  assert.ok(counter.count <= 1, `expected at most one whole-doc clone per tick, got ${counter.count}`);
  assert.equal(stored.length, 1);
  assert.equal(app.dirty, false, "a durable tick clears the dirty flag");
  assert.equal(app.savedRev, app.bus.revision());
  assert.doesNotMatch(app.status, /failed/i);
});

test("a tick with no pending edits performs zero serializations", async () => {
  const app = makeApp();
  edit(app);
  app.recoverySink = async () => {};
  await app.writeRecovery(); // durable baseline; dirty cleared
  disarm(app);
  const counter = countDocClones(app);
  try {
    await app.autosaveTick();
  } finally {
    counter.restore();
    disarm(app);
  }
  assert.equal(counter.count, 0, "an idle tick must not clone the document");
});

test("a failed project-library write announces truthfully (platform.enabled tick path)", async () => {
  const app = makeApp();
  edit(app);
  app.recoverySink = async () => {}; // recovery succeeds
  // Real store rejects in node (no indexedDB) — force=true bypasses the dirty
  // gate the successful recovery write just cleared, so this hits the project
  // sink directly.
  await app.writeRecovery();
  disarm(app);
  edit(app, 300);
  app.recoverySink = async () => {
    throw QUOTA_ERR;
  };
  await app.persistCurrentProject(true);
  disarm(app);
  assert.match(app.status, /Project autosave failed/i);
  assert.doesNotMatch(app.status, /saved to/i, "no fake success wording");
});
