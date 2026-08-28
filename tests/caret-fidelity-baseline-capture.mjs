/**
 * VIRO-0144 baseline capture — run ONCE on the unmodified engine (668d682).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs \
 *     tests/caret-fidelity-baseline-capture.mjs > tests/caret-fidelity-pixel-baseline.json
 *
 * Renders each case through the PRISTINE drawTypeFrame and records the raw
 * RGBA SHA-256. tests/caret-fidelity-pixel-baseline.test.mjs re-renders the
 * same cases through the changed engine and must reproduce every hash.
 * The cases deliberately avoid kerning/ligature-dependent boundaries
 * (bundled Noto shapes with kern+liga off by default), which is exactly the
 * surface acceptance 5 freezes: no glyph may move for stories that do not
 * opt into OpenType features.
 */
import { createHash } from "node:crypto";
import { loadFaces, makeCharacter, makeParagraph } from "./rich-text-harness.mjs";
import { renderFrame, makeStory, makeTextFrame, LOREM } from "./text-frame-harness.mjs";

const faces = await loadFaces();
const noto = faces["noto-sans"];
const notoBold = faces["noto-sans-bold"];

const styledStory = () => {
  const story = makeStory("Office avatar fixed rust", { id: "st_caret_runs" });
  story.runs = [
    { start: 0, end: 6, overrides: { fill: { r: 0.7, g: 0.1, b: 0.1, a: 1 }, size: 30 } },
    { start: 7, end: 13, overrides: { fontId: "noto-sans-bold", tracking: 20 } },
  ];
  return story;
};

const insetStory = () =>
  makeStory("Inset text flows inside the frame box with a comfortable measure.", {
    id: "st_caret_inset",
    paragraph: { align: "justify" },
  });

const rtlStory = () => makeStory("Static Latin probe for RTL-neutral pixels", { id: "st_caret_rtl" });

const cases = {
  "plain-left-multiline": () => ({ story: makeStory(LOREM, { id: "st_c1" }), w: 420, h: 300 }),
  "plain-justify-wrap": () => ({
    story: makeStory(LOREM, { id: "st_c2", paragraph: { align: "justify" } }),
    w: 500,
    h: 360,
  }),
  "plain-center-wrap": () => ({
    story: makeStory("Caret lines center under alignment slack", {
      id: "st_c3",
      paragraph: { align: "center" },
    }),
    w: 260,
    h: 220,
  }),
  "styled-runs": () => ({ story: styledStory(), w: 420, h: 200 }),
  "inset-frame": () => ({
    story: insetStory(),
    w: 380,
    h: 260,
    textFrame: makeTextFrame({ inset: { top: 14, right: 22, bottom: 18, left: 26 } }),
  }),
  "empty-frame": () => ({ story: makeStory("", { id: "st_c6" }), w: 300, h: 120 }),
};

const out = {
  meta: {
    packet: "VIRO-0144",
    capturedAt: "668d682",
    note:
      "Raw-RGBA SHA-256 captured from the unmodified engine at base 668d682 " +
      "(pre caret-cluster change). Cases use default kern/liga-off shaping: " +
      "the caret fidelity work must not move a single glyph for them.",
  },
  cases: {},
};

for (const [name, make] of Object.entries(cases)) {
  const { story, w, h, textFrame } = make();
  const { raw } = renderFrame(story, name === "styled-runs" ? noto : noto, w, h, textFrame);
  out.cases[name] = { w, h, sha: createHash("sha256").update(raw).digest("hex") };
}

// Touch the extra faces so the registry shape matches the test side.
void notoBold;
void rtlStory;

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
