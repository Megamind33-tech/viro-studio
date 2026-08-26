// VIRO Press — "Margin of Error" cover, composed entirely through Anchor ops.
//
// This file is the design, written the way a designer would write it: a grid
// declared once, every element placed against it, nothing nudged by eye.
// It emits `{ id, op, params, reason }` envelopes for window.viroAnchor —
// no tool clicks, no pixel offsets, no flattening. Everything it makes is a
// real layer the user can go on editing.
//
// Two batches, because the second needs the ids the first created:
//   1. CREATE   — ground, rules, type frames, marks, guides.
//   2. ASSEMBLE — group each zone and name it, then drop the selection.
// applyDetailed() hands back `created` per op, keyed by the envelope `id`,
// which is how the two batches are joined.

/* ---------------- page ---------------- */

export const PAGE = { w: 2480, h: 3508, bleed: 35 };

/**
 * The grid. Margin matches the document's own declared margin (150px), so the
 * pink margin guide in the app sits exactly on the layout — the layout is not
 * a second, private opinion about where the edge is.
 */
export const GRID = {
  m: 150,
  get left() { return this.m; },
  get right() { return PAGE.w - this.m; },
  get top() { return this.m; },
  get bottom() { return PAGE.h - this.m; },
  get measure() { return PAGE.w - this.m * 2; }, // 2180
  gutter: 40,
  cols: 4,
  get col() { return (this.measure - this.gutter * (this.cols - 1)) / this.cols; }, // 515
  /** Left edge of column i. */
  x(i) { return this.m + i * (this.col + this.gutter); },
  /** Width spanning n columns. */
  span(n) { return this.col * n + this.gutter * (n - 1); },
};

/** Restrained palette: warm paper, one near-black ink, the project copper, one grey. */
export const INK = {
  paper: "#F3F0E9",
  ink: "#191A1D",
  copper: "#E07A2F",
  grey: "#6E6A63",
};

/**
 * The compositor sets a type frame's first baseline about 1.1x the type size
 * below the frame top, then steps by `leading`. Frames are given height for
 * their lines plus a descender so nothing trips the red overflow marker.
 */
const firstBaseline = (size) => size * 1.1;
const frameHeight = (size, leading, lines) =>
  Math.ceil(firstBaseline(size) + leading * (lines - 1) + size * 0.35);

/* ---------------- vertical rhythm ---------------- */

const DISPLAY = { size: 400, leading: 360 };
const DECK = { size: 66, leading: 88 };
const BODY = { size: 36, leading: 54 };
const MICRO = { size: 32, leading: 44 };
const CAPTION = { size: 28, leading: 40 };

const HEAD_RULE_Y = GRID.top; // 150
const KICKER_Y = 182;
const DISPLAY_Y = 520;
// The second display frame continues the same baseline ladder: exactly two
// leadings below the first, so splitting the colour across two layers does not
// break the line spacing.
const DISPLAY_Y2 = DISPLAY_Y + DISPLAY.leading * 2; // 1240
const COPPER_RULE_Y = 1820;
const DECK_Y = 1900;
const DISC = { size: 200, y: DECK_Y };
const SECTION_RULE_Y = 2520;
const BODY_Y = 2570;
const COLOPHON_Y = 3226;
const FOOT_RULE_Y = GRID.bottom; // 3358

/* ---------------- copy ---------------- */

const KICKER = "VIRO PRESS · A QUARTERLY ON TYPE, INK AND TOLERANCE";
const ISSUE = "ISSUE 07 · AUTUMN 2026";
const DECK_TEXT =
  "How far can a sheet drift before the page stops being the page you drew? " +
  "Three pressrooms, one tolerance stack, and the arithmetic nobody prints.";
const COL_1 =
  "Every press is an argument with arithmetic. The plate is right, the paper is " +
  "right, and somewhere between the two a hundredth of a millimetre goes missing " +
  "and has to be found again at four thousand sheets an hour.\n\n" +
  "Registration is the polite word for it. What the pressroom actually watches is " +
  "drift — slow, patient, entirely reasonable drift.";
const COL_2 =
  "So the page is drawn twice. Once as the designer meant it, and once as the " +
  "stack of tolerances will allow it to arrive. The distance between those two " +
  "pages is the whole craft.\n\n" +
  "This cover was set in that second way: on a grid, to a margin, with the " +
  "measurements written down before anything was placed.";
const COLOPHON =
  "Set in Noto Sans. Composed live in VIRO Press through Anchor ops — every " +
  "mark on this page is an editable layer, not a picture of one.";
const FOLIO = "COVER · 01";

/* ---------------- batch 1: create ---------------- */

const rule = (id, y, x1, x2, color, width, name, reason) => ({
  id,
  op: "press.add_line",
  params: { x1, y1: y, x2, y2: y, stroke: { color, width }, name },
  reason,
});

/**
 * Every layer the cover is made of, back to front. Grouping happens in the
 * second batch, so this reads top-down like a layout does.
 */
export const CREATE_OPS = [
  // Column guides first, so the grid is document state a human can see, not
  // just arithmetic that lived in this file.
  ...[0, 1, 2, 3].flatMap((i) => [
    { op: "press.add_guide", params: { axis: "v", offset: GRID.x(i) }, reason: `column ${i + 1} left edge` },
    { op: "press.add_guide", params: { axis: "v", offset: GRID.x(i) + GRID.col }, reason: `column ${i + 1} right edge` },
  ]),
  { op: "press.add_guide", params: { axis: "h", offset: DISPLAY_Y }, reason: "display cap line" },
  { op: "press.add_guide", params: { axis: "h", offset: BODY_Y }, reason: "body column top" },

  // Ground. The only element allowed past the trim, and it goes exactly as far
  // as the declared 35px bleed — that is what a full bleed means.
  {
    id: "ground",
    op: "press.add_rect",
    params: {
      x: -PAGE.bleed,
      y: -PAGE.bleed,
      w: PAGE.w + PAGE.bleed * 2,
      h: PAGE.h + PAGE.bleed * 2,
      fill: INK.paper,
      name: "Paper — full bleed",
    },
    reason: "warm paper ground, run to the bleed line so the trim can wander",
  },

  // — masthead —
  rule("head-rule", HEAD_RULE_Y, GRID.left, GRID.right, INK.ink, 5, "Rule — head", "top of the type area, drawn as a rule"),
  {
    id: "kicker",
    op: "press.add_type_frame",
    params: {
      x: GRID.left,
      y: KICKER_Y,
      w: GRID.span(3),
      h: frameHeight(MICRO.size, MICRO.leading, 1),
      text: KICKER,
      size: MICRO.size,
      leading: MICRO.leading,
      tracking: 90,
      fill: INK.grey,
      name: "Kicker",
    },
    reason: "masthead line, letterspaced small caps weight against the display",
  },
  {
    id: "issue",
    op: "press.add_type_frame",
    params: {
      x: GRID.x(3) - GRID.col * 0.2,
      y: KICKER_Y,
      w: GRID.col * 1.2,
      h: frameHeight(MICRO.size, MICRO.leading, 1),
      text: ISSUE,
      size: MICRO.size,
      leading: MICRO.leading,
      tracking: 90,
      align: "right",
      fill: INK.grey,
      name: "Issue line",
    },
    reason: "issue stamp, flush right to the type area so the head reads as one line",
  },

  // — display —
  {
    id: "display-a",
    op: "press.add_type_frame",
    params: {
      x: GRID.left,
      y: DISPLAY_Y,
      w: GRID.measure,
      h: frameHeight(DISPLAY.size, DISPLAY.leading, 2),
      text: "MARGIN\nOF",
      size: DISPLAY.size,
      leading: DISPLAY.leading,
      tracking: -15,
      fill: INK.ink,
      name: "Display — MARGIN OF",
    },
    reason: "title, set solid: leading tighter than the size so the block reads as a shape",
  },
  {
    id: "display-b",
    op: "press.add_type_frame",
    params: {
      x: GRID.left,
      y: DISPLAY_Y2,
      w: GRID.measure,
      h: frameHeight(DISPLAY.size, DISPLAY.leading, 1),
      text: "ERROR",
      size: DISPLAY.size,
      leading: DISPLAY.leading,
      tracking: -15,
      fill: INK.copper,
      name: "Display — ERROR",
    },
    reason:
      "the accent word, its own layer because character colour is per story; " +
      "y is exactly two leadings on so the baseline ladder is unbroken",
  },
  rule("copper-rule", COPPER_RULE_Y, GRID.left, GRID.right, INK.copper, 12, "Rule — copper", "closes the title block and carries the accent across the full measure"),

  // — deck —
  {
    id: "deck",
    op: "press.add_type_frame",
    params: {
      x: GRID.left,
      y: DECK_Y,
      w: GRID.span(3),
      h: frameHeight(DECK.size, DECK.leading, 5),
      text: DECK_TEXT,
      size: DECK.size,
      leading: DECK.leading,
      fill: INK.ink,
      name: "Deck — standfirst",
    },
    reason: "standfirst at three columns, the step between display and body",
  },
  {
    id: "disc",
    op: "press.add_ellipse",
    params: {
      x: GRID.right - DISC.size,
      y: DISC.y,
      w: DISC.size,
      h: DISC.size,
      fill: INK.copper,
      name: "Issue disc",
    },
    reason: "copper disc in the fourth column, the counterweight to the deck",
  },
  {
    id: "disc-num",
    op: "press.add_type_frame",
    params: {
      // Nudged down by half a cap height so the numeral is optically centred in
      // the disc rather than sitting on its geometric middle.
      x: GRID.right - DISC.size,
      y: DISC.y + 28,
      w: DISC.size,
      h: DISC.size,
      text: "07",
      size: 96,
      leading: 120,
      align: "center",
      fill: INK.paper,
      name: "Issue numeral",
    },
    reason: "issue number reversed out of the disc",
  },

  // — body —
  rule("section-rule", SECTION_RULE_Y, GRID.left, GRID.left + GRID.col, INK.ink, 4, "Rule — section", "one-column rule marking the start of the running text"),
  {
    id: "body-1",
    op: "press.add_type_frame",
    params: {
      x: GRID.left,
      y: BODY_Y,
      w: GRID.span(2),
      h: frameHeight(BODY.size, BODY.leading, 12),
      text: COL_1,
      size: BODY.size,
      leading: BODY.leading,
      fill: INK.ink,
      name: "Column 1 — body",
    },
    reason: "first body column on the two-column half of the grid",
  },
  {
    id: "body-2",
    op: "press.add_type_frame",
    params: {
      x: GRID.left + GRID.span(2) + GRID.gutter,
      y: BODY_Y,
      w: GRID.span(2),
      h: frameHeight(BODY.size, BODY.leading, 12),
      text: COL_2,
      size: BODY.size,
      leading: BODY.leading,
      fill: INK.ink,
      name: "Column 2 — body",
    },
    reason: "second body column, same measure and leading so the two columns register",
  },

  // — colophon —
  {
    id: "colophon",
    op: "press.add_type_frame",
    params: {
      x: GRID.left,
      y: COLOPHON_Y,
      w: GRID.span(3),
      h: frameHeight(CAPTION.size, CAPTION.leading, 3),
      text: COLOPHON,
      size: CAPTION.size,
      leading: CAPTION.leading,
      fill: INK.grey,
      name: "Colophon — credit",
    },
    reason: "caption-scale credit, grey so it sits under the body in the hierarchy",
  },
  {
    id: "folio",
    op: "press.add_type_frame",
    params: {
      x: GRID.x(3) - GRID.col * 0.2,
      y: COLOPHON_Y,
      w: GRID.col * 1.2,
      h: frameHeight(CAPTION.size, CAPTION.leading, 1),
      text: FOLIO,
      size: CAPTION.size,
      leading: CAPTION.leading,
      align: "right",
      fill: INK.ink,
      name: "Folio",
    },
    reason: "folio flush right, mirroring the issue stamp in the masthead",
  },
  rule("foot-rule", FOOT_RULE_Y, GRID.left, GRID.right, INK.ink, 5, "Rule — foot", "bottom of the type area, bracketing the head rule"),
];

/* ---------------- batch 2: assemble ---------------- */

/** Zone name -> the envelope ids that belong in it, bottom of the stack first. */
export const ZONES = [
  { name: "Masthead", ids: ["head-rule", "kicker", "issue"] },
  { name: "Display", ids: ["display-a", "display-b", "copper-rule"] },
  { name: "Deck", ids: ["deck", "disc", "disc-num"] },
  { name: "Body", ids: ["section-rule", "body-1", "body-2"] },
  { name: "Colophon", ids: ["colophon", "folio", "foot-rule"] },
];

/** Layer names batch 1 must have produced — the assertion the scene checks. */
export const EXPECTED_LAYER_NAMES = CREATE_OPS.filter((o) => o.params?.name).map((o) => o.params.name);

/**
 * Second batch, built from the audit trail of the first.
 * `layerIdFor(envelopeId)` resolves an envelope id to the layer it created.
 * press.group leaves the new group selected, so press.set_name needs no target —
 * which is the contract's "create ops select the layer they just made".
 */
export function assemblyOps(layerIdFor) {
  const ops = [];
  for (const zone of ZONES) {
    const layerIds = zone.ids.map((id) => {
      const layerId = layerIdFor(id);
      if (!layerId) throw new Error(`no layer was created for envelope id "${id}"`);
      return layerId;
    });
    ops.push({
      op: "press.group",
      params: { layerIds },
      reason: `collect the ${zone.name.toLowerCase()} into one group so the Layers panel reads by zone`,
    });
    ops.push({
      op: "press.set_name",
      params: { name: zone.name },
      reason: `name the group just made — it is the current selection`,
    });
  }
  ops.push({
    op: "press.select",
    params: { layerIds: [] },
    reason: "drop the selection so the finished page is judged without handles on it",
  });
  return ops;
}
