/**
 * Google Fonts catalog index — metadata only; faces load on demand as TTF.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/font-catalog.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFaceUrl, catalogRecordId, searchCatalog } from "../src/engine/font-catalog.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(join(ROOT, "public/fonts/catalog.json"), "utf8"));

test("catalog.json is a real index of 1,500+ unique Google families", () => {
  assert.ok(Array.isArray(raw));
  assert.ok(raw.length >= 1500, `got ${raw.length}`);
  const ids = new Set(raw.map((f) => f.id));
  assert.equal(ids.size, raw.length, "ids must be unique");
  const first = raw[0];
  assert.equal(typeof first.id, "string");
  assert.equal(typeof first.family, "string");
  assert.ok(Array.isArray(first.weights));
});

test("searchCatalog finds Inter and caps results", () => {
  const hits = searchCatalog(raw, "inter", 12);
  assert.ok(hits.some((f) => f.id === "inter" || f.family.toLowerCase().includes("inter")));
  assert.ok(hits.length <= 12);
});

test("empty query returns a bounded preview, not the whole 2k list", () => {
  const hits = searchCatalog(raw, "", 80);
  assert.equal(hits.length, 80);
});

test("catalogFaceUrl points at a Fontsource TTF, not a decorative name", () => {
  const inter = raw.find((f) => f.id === "inter") ?? raw.find((f) => f.weights?.includes(400));
  assert.ok(inter, "need a 400-weight family");
  const url = catalogFaceUrl(inter, 400, false);
  assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/.+@latest\/.+-400-normal\.ttf$/);
  assert.equal(catalogRecordId(inter, 400, false), `gf-${inter.id}-400-n`);
});
