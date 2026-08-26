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

export type LayerEffect = DropShadowEffect;

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

export interface VectorLayer extends LayerBase {
  kind: "vector";
  closed: boolean;
  nodes: PathNode[];
  fill: Rgba | null;
  stroke: { color: Rgba; width: number } | null;
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
   */
  version: 1 | 2 | 3 | 4;
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
  shapePreview: { kind: "rect" | "ellipse" | "line"; x: number; y: number; w: number; h: number } | null;
  /** Live type-edit caret. Painted by the overlay; null when not editing. */
  textEdit: { layerId: string; anchor: number; focus: number } | null;
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
