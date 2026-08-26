/**
 * Honest auth seam — never invents a session when cloud is unprovisioned.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/auth.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { authAvailable, currentUser, signIn, signUp, signOut } from "../src/platform/auth.ts";
import { resetFlags, setFlag } from "../src/platform/flags.ts";

test("unprovisioned: currentUser is null and authAvailable is false", () => {
  resetFlags();
  signOut();
  assert.equal(currentUser(), null);
  assert.equal(authAvailable(), false);
});

test("signIn throws an honest message when platform.cloud is off", async () => {
  resetFlags();
  await assert.rejects(
    () => signIn("a@b.c", "secret-password"),
    /Cloud sign-in is off/,
  );
});

test("signUp throws an honest message when cloud is on but secrets are missing", async () => {
  resetFlags();
  setFlag("platform.cloud", true);
  await assert.rejects(
    () => signUp("a@b.c", "secret-password"),
    /not provisioned|missing VITE_SUPABASE/,
  );
  resetFlags();
});
