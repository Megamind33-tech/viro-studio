/** VIRO Press document model — one graph for poster, magazine, photo, vector, broadcast. */

export type BlendMode =
  | "srcOver"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "colorDodge"
  | "colorBurn"
  | "hardLight"
  | "softLight"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export type ColorSpace = "rgb" | "cmyk";
export type RenderIntent = "perceptual" | "relative" | "saturation" | "absolute";
export type ResampleAlgo = "nearest" | "bilinear" | "bicubic";
/**
 * Three genuinely distinct modes. "fill" existed as a fourth and was
 * byte-identical to "stretch" in every renderer, so it was removed in document
 * v3 and is migrated to "stretch". See document/image-fit.ts.
 */
export type ImageFit = "cover" | "contain" | "stretch";
export type Align = "left" | "center" | "right" | "justify";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Cmyk {
  c: number;
  m: number;
  y: number;
  k: number;
}

export interface Swatch {
  id: string;
  name: string;
  space: ColorSpace;
  rgb?: Rgba;
  cmyk?: Cmyk;
}

export interface Transform {
  /** Local to the parent layer, or to the page when parentId is null. */
  x: number;
  y: number;
  /** Intrinsic box in this layer's own local space. Leaf geometry lives in [0,0,w,h]. */
  w: number;
  h: number;
  /** Degrees, clockwise, about the centre of the w x h box. */
  rotation: number;
  /**
   * Local scale about the same centre. Absent means 1, which is how v1
   * documents read. Resizing a LEAF edits w/h; resizing a GROUP edits scale,
   * because a group has no geometry of its own. See document/transform.ts.
   */
  scaleX?: number;
  scaleY?: number;
}

/**
 * Non-destructive layer effects (Photoshop "layer style" family). Applied by the
 * compositor when rendering the layer, and by the exporter, so canvas and output
 * stay identical. Absent on v1–v4 documents; additive and forward/backward safe.
 */
export interface DropShadowEffect {
  type: "drop-shadow";
  enabled: boolean;
  /** 0..1 float channels, matching Rgba elsewhere. */
  color: Rgba;
  offsetX: number;
  offsetY: number;
  /** Blur radius in page px. */
  blur: number;
  /** 0..1, multiplies the shadow colour's alpha. */
  opacity: number;
}

export interface GradientStop {
  /** 0..1 position along the gradient. */
  offset: number;
  color: Rgba;
}

/**
 * A gradient painted over the layer's silhouette (Photoshop "Gradient Overlay").
 * Clipped to the layer's existing alpha, so a rectangle, an image or glyph runs
 * all take the gradient in their own shape. Additive effect — no schema bump.
 */
export interface GradientOverlayEffect {
  type: "gradient-overlay";
  enabled: boolean;
  /** Degrees, clockwise from +x, across the layer box. */
  angle: number;
  stops: GradientStop[];
  /** 0..1 overall overlay opacity. */
  opacity: number;
}

/**
 * A solid outline traced around the layer's silhouette (Photoshop "Stroke").
 * Renders for any layer kind by dilating its alpha and tinting the ring that
 * stands proud of the original content. Additive effect — no schema bump.
 */
export interface StrokeEffect {
  type: "stroke";
  enabled: boolean;
  /** 0..1 float channels, matching Rgba elsewhere. */
  color: Rgba;
  /** Outline width in page px, drawn outward from the silhouette. */
  width: number;
  /** 0..1, multiplies the stroke colour's alpha. */
  opacity: number;
}

/**
 * A soft coloured halo bleeding outward from the layer's silhouette (Photoshop
 * "Outer Glow") — a blurred silhouette of the glow colour drawn behind the
 * layer, i.e. a zero-offset drop shadow in a light colour. Additive — no bump.
 */
export interface OuterGlowEffect {
  type: "outer-glow";
  enabled: boolean;
  /** 0..1 float channels, matching Rgba elsewhere. */
  color: Rgba;
  /** Blur radius in page px. */
  blur: number;
  /** 0..1, multiplies the glow colour's alpha. */
  opacity: number;
}

/**
 * A shadow cast *inside* the layer's silhouette (Photoshop "Inner Shadow").
 * Same fields as drop shadow; compositor clips the blurred offset to the
 * layer's own alpha so it never spills outside. Additive — no schema bump.
 */
export interface InnerShadowEffect {
  type: "inner-shadow";
  enabled: boolean;
  color: Rgba;
  offsetX: number;
  offsetY: number;
  blur: number;
  opacity: number;
}

/**
 * A long/extruded shadow that reads as 3D on a 2D page (Material "long shadow",
 * isometric extrusion). Drawn as stacked zero-blur offsets along `angle` for
 * `length` page px. Additive — no schema bump.
 */
export interface LongShadowEffect {
  type: "long-shadow";
  enabled: boolean;
  color: Rgba;
  /** Degrees clockwise from +x. 135° is down-right, the usual 3D-on-2D cast. */
  angle: number;
  /** Extrusion length in page px. */
  length: number;
  opacity: number;
}

export type LayerEffect =
  | DropShadowEffect
  | GradientOverlayEffect
  | StrokeEffect
  | OuterGlowEffect
  | InnerShadowEffect
  | LongShadowEffect;

export interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  transform: Transform;
  parentId: string | null;
  /** Non-destructive effects rendered under/over the layer. Optional for back-compat. */
  effects?: LayerEffect[];
}

export interface RasterLayer extends LayerBase {
  kind: "raster";
  assetId: string | null;
}

export interface ImageFrameLayer extends LayerBase {
  kind: "image-frame";
  assetId: string | null;
  fit: ImageFit;
  focal: { x: number; y: number };
  /** Source-pixel crop. Null = full asset. Reframe changes the frame; crop changes the source window. */
  crop: { x: number; y: number; w: number; h: number } | null;
}

export interface TypeFrameLayer extends LayerBase {
  kind: "type-frame";
  storyId: string;
  nextFrameId: string | null;
  /**
   * v4 text-container semantics. Absent only while a v1-v3 document is being
   * migrated; current documents always carry this object.
   */
  textFrame?: TextFrameProperties;
}

export interface PathNode {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

/** How a stroke terminates at an open end. Skia default is "butt". */
export type StrokeCap = "butt" | "round" | "square";
/** How a stroke turns a corner. Skia default is "miter". */
export type StrokeJoin = "miter" | "round" | "bevel";

/**
 * A vector layer's outline. `dash`/`cap`/`join` are optional and were added in
 * document v5; a v1–v4 stroke that omits them renders solid, butt-capped and
 * miter-joined exactly as before (the v5 migration is a widening version stamp).
 */
export interface VectorStroke {
  color: Rgba;
  width: number;
  /**
   * On/off dash intervals in page px. Skia requires an even count (≥2); an
   * absent or empty array is a solid stroke. `dashPhase` shifts the pattern.
   */
  dash?: number[];
  dashPhase?: number;
  cap?: StrokeCap;
  join?: StrokeJoin;
}

/**
 * One subpath of a vector layer: a run of bezier nodes that is either open or
 * closed, in the same local space as the layer's legacy `nodes`. Multiple
 * contours make a compound path (an outer ring plus inner holes, or several
 * disjoint pieces) — the shape a boolean op (subtract/union/…) produces.
 * Added in document v6 (ADR 0005).
 */
export interface Contour {
  nodes: PathNode[];
  closed: boolean;
}

/**
 * A vector layer.
 *
 * PRECEDENCE (v6, ADR 0005): a layer is EITHER a single contour carried by the
 * legacy `nodes`/`closed` fields, OR a compound path carried by an optional
 * `contours` list. When `contours` is present and non-empty it is AUTHORITATIVE:
 * the compositor, validator, hash and hit-tests read `contours` and ignore
 * `nodes`/`closed`. When `contours` is absent or empty the layer is the single
 * contour `{ nodes, closed }`, exactly as in v1–v5 — so every existing vector is
 * already a valid v6 one-contour vector and the v5→v6 migration moves no pixels.
 * `nodes` is retained (never removed) so v6 stays structurally a superset of v5.
 */
export interface VectorLayer extends LayerBase {
  kind: "vector";
  closed: boolean;
  nodes: PathNode[];
  fill: Rgba | null;
  stroke: VectorStroke | null;
  /** Optional multi-contour (compound-path) geometry. See PRECEDENCE above. */
  contours?: Contour[];
}

export interface GroupLayer extends LayerBase {
  kind: "group";
}

export interface AdjustmentLayer extends LayerBase {
  kind: "adjustment";
  adjustment: { type: "brightness-contrast"; brightness: number; contrast: number };
}

export type Layer =
  | RasterLayer
  | ImageFrameLayer
  | TypeFrameLayer
  | VectorLayer
  | GroupLayer
  | AdjustmentLayer;

export interface Guide {
  id: string;
  axis: "h" | "v";
  offset: number;
}

export interface CharacterStyle {
  fontId: string;
  size: number;
  leading: number;
  tracking: number;
  fill: Rgba;
  otFeatures: string[];
  /** Requested face metadata survives even when `fontId` cannot be resolved. */
  fontRequest?: FontRequest;
  /** BCP 47 language tag; `und` means deliberately unspecified. */
  language?: string;
  /** ISO 15924 script tag when the author overrides automatic detection. */
  script?: string;
  direction?: TextDirection;
  horizontalScale?: number;
  verticalScale?: number;
  baselineShift?: number;
  rotation?: number;
  stroke?: { color: Rgba; width: number } | null;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface ParagraphStyle {
  align: Align;
  firstLineIndent: number;
  spaceAfter: number;
  startIndent?: number;
  endIndent?: number;
  spaceBefore?: number;
  direction?: TextDirection;
  hyphenate?: boolean;
  keepWithNext?: boolean;
  keepLinesTogether?: boolean;
  widowLines?: number;
  orphanLines?: number;
}

export type TextDirection = "auto" | "ltr" | "rtl";
export type TextContainerKind = "point" | "area" | "path";
export type TextVerticalAlign = "top" | "center" | "bottom" | "justify";
export type TextAutoSize = "none" | "height" | "width" | "both";

export interface FontRequest {
  family?: string;
  postScriptName?: string;
  style?: string;
  weight?: number;
  width?: number;
  axes?: Record<string, number>;
  fallbackFontIds?: string[];
}

export interface CharacterRun {
  /** UTF-16 code-unit offsets, matching JavaScript string indices. End is exclusive. */
  start: number;
  end: number;
  styleId: string | null;
  overrides: Partial<CharacterStyle>;
}

export interface ParagraphRun {
  /** UTF-16 code-unit offsets. Public writers expand these to paragraph boundaries. */
  start: number;
  end: number;
  styleId: string | null;
  overrides: Partial<ParagraphStyle>;
}

export interface NamedCharacterStyle {
  id: string;
  name: string;
  basedOnId: string | null;
  properties: Partial<CharacterStyle>;
}

export interface NamedParagraphStyle {
  id: string;
  name: string;
  basedOnId: string | null;
  properties: Partial<ParagraphStyle>;
}

export interface TextStyleRegistry {
  character: Record<string, NamedCharacterStyle>;
  paragraph: Record<string, NamedParagraphStyle>;
}

export interface TextFrameProperties {
  kind: TextContainerKind;
  inset: { top: number; right: number; bottom: number; left: number };
  columns: number;
  columnGutter: number;
  verticalAlign: TextVerticalAlign;
  autoSize: TextAutoSize;
  /** Required only for path text. */
  pathLayerId?: string | null;
  pathStartOffset?: number;
  pathFlip?: boolean;
}

export interface Story {
  id: string;
  text: string;
  character: CharacterStyle;
  paragraph: ParagraphStyle;
  /** Sparse character formatting ranges. Absent only on unmigrated v1-v3 input. */
  runs?: CharacterRun[];
  /** Sparse paragraph formatting ranges. Absent only on unmigrated v1-v3 input. */
  paragraphRuns?: ParagraphRun[];
}

export interface Asset {
  id: string;
  name: string;
  mime: string;
  /** data URL or blob URL — kept with the document for undo of Place */
  dataUrl: string;
  width: number;
  height: number;
}

export interface Page {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  bleedPx: number;
  slugPx: number;
  margin: { top: number; right: number; bottom: number; left: number };
  columns: number;
  columnGutter: number;
  background: Rgba;
  layers: Layer[];
  guides: Guide[];
}

export interface Spread {
  id: string;
  pageIds: string[];
}

export interface HistoryEntry {
  id: string;
  label: string;
  at: number;
}

export interface PressDocument {
  /**
   * 1 = absolute transforms (pre-hierarchy). 2 = local transforms.
   * 3 = ImageFit "fill" collapsed into "stretch".
   * 4 = versioned rich-text ranges, style registries and text-frame semantics.
   * 5 = vector stroke styling (dash/cap/join) — a widening stamp; v1–v4 strokes
   *     stay valid and render identically (solid, butt cap, miter join).
   * 6 = multi-contour (compound-path) vectors for boolean ops (ADR 0005) — a
   *     widening stamp; a v≤5 vector is already a valid v6 one-contour vector,
   *     so nothing is rewritten and no pixels move.
   */
  version: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  ppi: number;
  color: {
    workingSpace: ColorSpace;
    intent: RenderIntent;
    iccProfileName: string | null;
  };
  pages: Page[];
  spreads: Spread[];
  stories: Story[];
  /** Present on v4 documents; optional only so v1-v3 JSON can be migrated. */
  textStyles?: TextStyleRegistry;
  /** requested fontId -> explicit replacement fontId; never applied silently */
  fontSubstitutions?: Record<string, string>;
  assets: Record<string, Asset>;
  swatches: Swatch[];
  activePageId: string;
  activeLayerIds: string[];
}

export type ToolId =
  | "move"
  | "marquee"
  | "type"
  | "pen"
  | "rect"
  | "ellipse"
  | "line"
  | "roundrect"
  | "polygon"
  | "eyedropper"
  | "rotate"
  | "guide"
  | "frame"
  | "crop"
  | "hand"
  | "zoom";

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
  showRulers: boolean;
  showBleed: boolean;
  showGuides: boolean;
  tool: ToolId;
  fg: Rgba;
  bg: Rgba;
  marquee: { x: number; y: number; w: number; h: number } | null;
  /** Live shape-tool feedback mid-drag, in page px. Null when not dragging. */
  shapePreview: {
    kind: "rect" | "ellipse" | "line" | "roundrect" | "polygon";
    x: number;
    y: number;
    w: number;
    h: number;
    radius?: number;
    sides?: number;
  } | null;
  /** Live type-edit caret. Painted by the overlay; null when not editing. */
  textEdit: { layerId: string; anchor: number; focus: number } | null;
  /**
   * Live smart-guide alignment lines mid-move, in page px. Null when no guides
   * are showing. The arrays are fixed-capacity and reused across pointer events
   * (only `xn`/`yn` change), so the move hot path allocates nothing per frame.
   */
  smartGuides: { xs: Float64Array; xn: number; ys: Float64Array; yn: number } | null;
}

export const SKIA_BLEND: Record<BlendMode, string> = {
  srcOver: "SrcOver",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  colorDodge: "ColorDodge",
  colorBurn: "ColorBurn",
  hardLight: "HardLight",
  softLight: "SoftLight",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};
