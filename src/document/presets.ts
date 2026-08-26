import type { ColorSpace, PressDocument, RenderIntent } from "./types";
import { createDocument, inToPx, mmToPx, pxToIn, pxToMm } from "./factory";

export { mmToPx, pxToMm, inToPx, pxToIn };

/**
 * New Document catalogue.
 *
 * Every physical size here is a published specification, not an approximation:
 *   - ISO 216 A-series (A1 594×841 mm … A6 105×148 mm)
 *   - ANSI / US loose sizes (Letter 8.5×11 in, Legal 8.5×14 in, Tabloid 11×17 in)
 *   - Trade bleed: 3 mm metric, 0.125 in (3.175 mm) US
 *   - Platform pixel specs for social and display advertising
 *   - Device logical-point sizes for mobile
 *
 * Pixel dimensions are derived, never typed in by hand: px = round(physical / unit-per-inch * ppi).
 * A4 at 300 ppi therefore lands on the canonical 2480 × 3508.
 */

export type PresetCategory = "print" | "screen" | "social" | "mobile";
export type PresetUnit = "px" | "mm" | "in";

export interface PresetMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Preset {
  id: string;
  category: PresetCategory;
  /** Sub-group label inside the category. Also what the New dialog shows beside the name. */
  family: string;
  name: string;
  /** One line of why this size is what it is. */
  description: string;
  width: number;
  height: number;
  unit: PresetUnit;
  ppi: number;
  /** Bleed is always physical, always millimetres. US trade bleed 0.125 in = 3.175 mm. */
  bleedMm: number;
  /** Margins in `unit`. On facing-page presets `left` is the inside (binding) edge. */
  margin: PresetMargin;
  columns: number;
  /** Column gutter in `unit`. */
  gutter: number;
  colorSpace: ColorSpace;
  intent: RenderIntent;
  facingPages: boolean;
  pageCount: number;
}

export interface PresetCategoryInfo {
  id: PresetCategory;
  label: string;
  blurb: string;
}

export const PRESET_CATEGORIES: PresetCategoryInfo[] = [
  { id: "print", label: "Print", blurb: "Physical sizes at 300 ppi with trade bleed and live-area margins." },
  { id: "screen", label: "Screen / Web", blurb: "Viewport and display-ad pixel sizes at 72 ppi, RGB." },
  { id: "social", label: "Social", blurb: "Platform pixel specifications with published safe areas." },
  { id: "mobile", label: "Mobile / Device", blurb: "Device logical point sizes, 1×." },
];

const MM = "mm" as const;
const IN = "in" as const;
const PX = "px" as const;

/** Metric trade bleed. */
const BLEED_MM = 3;
/** US trade bleed, 0.125 in expressed exactly in millimetres. */
const BLEED_IN_MM = 3.175;

/** InDesign's default column gutter is 12 pt = 1/6 in = 4.2333… mm. Computed, not typed in. */
const GUTTER_MM = 25.4 / 6;

function m(top: number, right = top, bottom = top, left = right): PresetMargin {
  return { top, right, bottom, left };
}

const PRINT: Preset[] = [
  /* --- ISO A-series, 300 ppi ------------------------------------- */
  {
    id: "print-a4",
    category: "print",
    family: "A-series",
    name: "A4 — 210 × 297 mm",
    description: "ISO 216 A4 at 300 ppi → 2480 × 3508 px. 3 mm bleed, 12.7 mm margins.",
    width: 210,
    height: 297,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: m(12.7),
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-a4-landscape",
    category: "print",
    family: "A-series",
    name: "A4 landscape — 297 × 210 mm",
    description: "A4 turned. 300 ppi → 3508 × 2480 px. Two columns for a folded leaflet.",
    width: 297,
    height: 210,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: m(12.7),
    columns: 2,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-a3",
    category: "print",
    family: "A-series",
    name: "A3 — 297 × 420 mm",
    description: "ISO 216 A3 at 300 ppi → 3508 × 4961 px. Poster and presentation board size.",
    width: 297,
    height: 420,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: m(15),
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-a5",
    category: "print",
    family: "A-series",
    name: "A5 — 148 × 210 mm",
    description: "ISO 216 A5 at 300 ppi → 1748 × 2480 px. Flyer, programme, half-A4 leaflet.",
    width: 148,
    height: 210,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: m(10),
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-a6",
    category: "print",
    family: "A-series",
    name: "A6 postcard — 105 × 148 mm",
    description: "ISO 216 A6 at 300 ppi → 1240 × 1748 px. The metric postcard and flyer size.",
    width: 105,
    height: 148,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: m(8),
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },

  /* --- Large format. 150 ppi is the standard finished-size resolution
         for large-format print; 300 ppi at A1 is 35 Mpx of raster nobody
         can see from two metres away. ---------------------------------- */
  {
    id: "print-a2-poster",
    category: "print",
    family: "Large format",
    name: "A2 poster — 420 × 594 mm",
    description: "ISO A2 at 150 ppi (large-format standard) → 2480 × 3508 px. 3 mm bleed.",
    width: 420,
    height: 594,
    unit: MM,
    ppi: 150,
    bleedMm: BLEED_MM,
    margin: m(20),
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-a1-poster",
    category: "print",
    family: "Large format",
    name: "A1 poster — 594 × 841 mm",
    description: "ISO A1 at 150 ppi → 3508 × 4967 px. Billposter and exhibition size.",
    width: 594,
    height: 841,
    unit: MM,
    ppi: 150,
    bleedMm: BLEED_MM,
    margin: m(25),
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-poster-18x24",
    category: "print",
    family: "Large format",
    name: "US poster — 18 × 24 in",
    description: "US standard poster at 150 ppi → 2700 × 3600 px. 0.125 in bleed.",
    width: 18,
    height: 24,
    unit: IN,
    ppi: 150,
    bleedMm: BLEED_IN_MM,
    margin: m(1),
    columns: 1,
    gutter: 1 / 6,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-poster-24x36",
    category: "print",
    family: "Large format",
    name: "US poster — 24 × 36 in",
    description: "One-sheet poster at 150 ppi → 3600 × 5400 px. 0.125 in bleed.",
    width: 24,
    height: 36,
    unit: IN,
    ppi: 150,
    bleedMm: BLEED_IN_MM,
    margin: m(1.5),
    columns: 1,
    gutter: 1 / 6,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },

  /* --- North American loose sizes, 300 ppi ------------------------ */
  {
    id: "print-letter",
    category: "print",
    family: "North America",
    name: "US Letter — 8.5 × 11 in",
    description: "ANSI A at 300 ppi → 2550 × 3300 px. 0.125 in bleed, 0.5 in margins.",
    width: 8.5,
    height: 11,
    unit: IN,
    ppi: 300,
    bleedMm: BLEED_IN_MM,
    margin: m(0.5),
    columns: 1,
    gutter: 1 / 6,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-letter-landscape",
    category: "print",
    family: "North America",
    name: "US Letter landscape — 11 × 8.5 in",
    description: "Letter turned at 300 ppi → 3300 × 2550 px. Three columns for a tri-fold.",
    width: 11,
    height: 8.5,
    unit: IN,
    ppi: 300,
    bleedMm: BLEED_IN_MM,
    margin: m(0.5),
    columns: 3,
    gutter: 1 / 6,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-legal",
    category: "print",
    family: "North America",
    name: "US Legal — 8.5 × 14 in",
    description: "Legal at 300 ppi → 2550 × 4200 px. 0.125 in bleed.",
    width: 8.5,
    height: 14,
    unit: IN,
    ppi: 300,
    bleedMm: BLEED_IN_MM,
    margin: m(0.5),
    columns: 1,
    gutter: 1 / 6,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-tabloid",
    category: "print",
    family: "North America",
    name: "Tabloid — 11 × 17 in",
    description: "ANSI B / ledger at 300 ppi → 3300 × 5100 px. Newsprint and large flyer size.",
    width: 11,
    height: 17,
    unit: IN,
    ppi: 300,
    bleedMm: BLEED_IN_MM,
    margin: m(0.625),
    columns: 4,
    gutter: 1 / 6,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },

  /* --- Cards and mail --------------------------------------------- */
  {
    id: "print-card-us",
    category: "print",
    family: "Cards & mail",
    name: "Business card US — 3.5 × 2 in",
    description: "US card at 300 ppi → 1050 × 600 px. 0.125 in bleed, 0.125 in safe margin. Two pages: front and back.",
    width: 3.5,
    height: 2,
    unit: IN,
    ppi: 300,
    bleedMm: BLEED_IN_MM,
    margin: m(0.125),
    columns: 1,
    gutter: 1 / 12,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 2,
  },
  {
    id: "print-card-eu",
    category: "print",
    family: "Cards & mail",
    name: "Business card EU — 85 × 55 mm",
    description: "European card at 300 ppi → 1004 × 650 px. 3 mm bleed, 4 mm safe margin. Two pages.",
    width: 85,
    height: 55,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: m(4),
    columns: 1,
    gutter: 3,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 2,
  },
  {
    id: "print-postcard-us",
    category: "print",
    family: "Cards & mail",
    name: "Postcard — 6 × 4 in",
    description: "US postcard at 300 ppi → 1800 × 1200 px. 0.125 in bleed. Two pages: picture and address side.",
    width: 6,
    height: 4,
    unit: IN,
    ppi: 300,
    bleedMm: BLEED_IN_MM,
    margin: m(0.25),
    columns: 2,
    gutter: 1 / 6,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 2,
  },
  {
    id: "print-photo-8x10",
    category: "print",
    family: "Cards & mail",
    name: "Photo print — 8 × 10 in",
    description:
      "Lab photo print at 300 ppi → 2400 × 3000 px. RGB, because a photo lab prints from RGB and does its own " +
      "separation; no bleed, because the lab trims to the ordered size.",
    width: 8,
    height: 10,
    unit: IN,
    ppi: 300,
    bleedMm: 0,
    margin: m(0.25),
    columns: 1,
    gutter: 1 / 6,
    colorSpace: "rgb",
    intent: "perceptual",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "print-dl",
    category: "print",
    family: "Cards & mail",
    name: "DL insert — 99 × 210 mm",
    description: "Third-of-A4 DL insert at 300 ppi → 1169 × 2480 px. Fits a DL envelope.",
    width: 99,
    height: 210,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: m(8),
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },

  /* --- Editorial, facing pages ------------------------------------ */
  {
    id: "print-magazine-a4",
    category: "print",
    family: "Editorial",
    name: "Magazine A4 — facing, 8 pp",
    description: "A4 at 300 ppi, three columns, mirrored margins (14 mm inside / 18 mm outside). Page 1 is a cover.",
    width: 210,
    height: 297,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: { top: 15, right: 18, bottom: 22, left: 14 },
    columns: 3,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: true,
    pageCount: 8,
  },
  {
    id: "print-booklet-a5",
    category: "print",
    family: "Editorial",
    name: "Booklet A5 — facing, 8 pp",
    description: "A5 at 300 ppi, single column, mirrored margins. Saddle-stitch page count stays a multiple of four.",
    width: 148,
    height: 210,
    unit: MM,
    ppi: 300,
    bleedMm: BLEED_MM,
    margin: { top: 13, right: 15, bottom: 18, left: 12 },
    columns: 1,
    gutter: GUTTER_MM,
    colorSpace: "cmyk",
    intent: "relative",
    facingPages: true,
    pageCount: 8,
  },
];

const SCREEN: Preset[] = [
  {
    id: "screen-desktop-1440",
    category: "screen",
    family: "Web",
    name: "Desktop — 1440 × 1024",
    description: "The common desktop design frame. Twelve columns, 24 px gutter, 80 px page margin.",
    width: 1440,
    height: 1024,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(80),
    columns: 12,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "screen-fullhd",
    category: "screen",
    family: "Web",
    name: "Full HD — 1920 × 1080",
    description: "1080p viewport, also the 16:9 slide size. Twelve columns, 32 px gutter.",
    width: 1920,
    height: 1080,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(96),
    columns: 12,
    gutter: 32,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "screen-laptop-1366",
    category: "screen",
    family: "Web",
    name: "Laptop — 1366 × 768",
    description: "The most common laptop viewport still in the wild. Twelve columns, 24 px gutter.",
    width: 1366,
    height: 768,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(64),
    columns: 12,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "screen-uhd",
    category: "screen",
    family: "Web",
    name: "4K UHD — 3840 × 2160",
    description: "UHD display or 4× asset master. Twelve columns, 64 px gutter.",
    width: 3840,
    height: 2160,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(192),
    columns: 12,
    gutter: 64,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "screen-email",
    category: "screen",
    family: "Email",
    name: "Email body — 600 × 1200",
    description: "600 px is the width every mail client renders without horizontal scroll. Height is the scroll length.",
    width: 600,
    height: 1200,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(24),
    columns: 1,
    gutter: 16,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "screen-ad-mpu",
    category: "screen",
    family: "Display advertising",
    name: "Medium rectangle — 300 × 250",
    description: "IAB medium rectangle, the most widely accepted display unit.",
    width: 300,
    height: 250,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(16),
    columns: 1,
    gutter: 8,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "screen-ad-leaderboard",
    category: "screen",
    family: "Display advertising",
    name: "Leaderboard — 728 × 90",
    description: "IAB leaderboard. Very short measure: one line of display type and a mark.",
    width: 728,
    height: 90,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(12, 16),
    columns: 1,
    gutter: 8,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
];

const SOCIAL: Preset[] = [
  {
    id: "social-square",
    category: "social",
    family: "Feed",
    name: "Square post — 1080 × 1080",
    description: "1:1 feed post. The safe size on every network.",
    width: 1080,
    height: 1080,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(64),
    columns: 6,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-portrait",
    category: "social",
    family: "Feed",
    name: "Portrait post — 1080 × 1350",
    description: "4:5, the tallest crop a feed will show without cutting. Most screen area per post.",
    width: 1080,
    height: 1350,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(64),
    columns: 6,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-landscape",
    category: "social",
    family: "Feed",
    name: "Landscape post — 1080 × 566",
    description: "1.91:1, the widest feed crop.",
    width: 1080,
    height: 566,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(48, 56),
    columns: 6,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-story",
    category: "social",
    family: "Vertical video",
    name: "Story / Reel — 1080 × 1920",
    description: "9:16 full screen. Margins mark the 250 px top and bottom zone that platform UI covers.",
    width: 1080,
    height: 1920,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: { top: 250, right: 80, bottom: 250, left: 80 },
    columns: 1,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-link-preview",
    category: "social",
    family: "Sharing",
    name: "Link preview — 1200 × 630",
    description: "1.91:1 open-graph card used by Facebook, LinkedIn and most link unfurlers.",
    width: 1200,
    height: 630,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(56, 64),
    columns: 6,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-x-post",
    category: "social",
    family: "Sharing",
    name: "X in-stream — 1600 × 900",
    description: "16:9 in-stream image at full display width.",
    width: 1600,
    height: 900,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(72, 80),
    columns: 6,
    gutter: 32,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-yt-thumb",
    category: "social",
    family: "Video",
    name: "Video thumbnail — 1280 × 720",
    description: "16:9 thumbnail. Type has to survive being shown at 210 px wide.",
    width: 1280,
    height: 720,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(56, 64),
    columns: 4,
    gutter: 32,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-yt-banner",
    category: "social",
    family: "Video",
    name: "Channel banner — 2560 × 1440",
    description: "Margins mark the 1546 × 423 centre area that is visible on every device, TV included.",
    width: 2560,
    height: 1440,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: { top: 508, right: 507, bottom: 509, left: 507 },
    columns: 1,
    gutter: 32,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-pin",
    category: "social",
    family: "Feed",
    name: "Pin — 1000 × 1500",
    description: "2:3, the aspect Pinterest ranks best.",
    width: 1000,
    height: 1500,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(60),
    columns: 4,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "social-linkedin-banner",
    category: "social",
    family: "Profile",
    name: "LinkedIn banner — 1584 × 396",
    description: "4:1 profile banner. The left third is covered by the avatar on desktop.",
    width: 1584,
    height: 396,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(48),
    columns: 4,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
];

const MOBILE: Preset[] = [
  {
    id: "mobile-iphone-16-pro",
    category: "mobile",
    family: "iOS",
    name: "iPhone 16 Pro — 402 × 874",
    description: "Logical points at 1×. Export at 3× for the device.",
    width: 402,
    height: 874,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(16),
    columns: 4,
    gutter: 16,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "mobile-iphone-16",
    category: "mobile",
    family: "iOS",
    name: "iPhone 15 / 16 — 393 × 852",
    description: "Logical points at 1×. Export at 3× for the device.",
    width: 393,
    height: 852,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(16),
    columns: 4,
    gutter: 16,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "mobile-iphone-se",
    category: "mobile",
    family: "iOS",
    name: "iPhone SE — 375 × 667",
    description: "The smallest current iOS frame. If a layout survives here it survives everywhere.",
    width: 375,
    height: 667,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(16),
    columns: 4,
    gutter: 16,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "mobile-android",
    category: "mobile",
    family: "Android",
    name: "Android phone — 412 × 917",
    description: "Density-independent pixels at 1×. Export at 3× (xxhdpi) or 4× (xxxhdpi).",
    width: 412,
    height: 917,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(16),
    columns: 4,
    gutter: 16,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "mobile-android-compact",
    category: "mobile",
    family: "Android",
    name: "Android compact — 360 × 800",
    description: "The baseline compact width Material layouts are checked against.",
    width: 360,
    height: 800,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(16),
    columns: 4,
    gutter: 16,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "mobile-ipad-11",
    category: "mobile",
    family: "Tablet",
    name: 'iPad Pro 11" — 834 × 1194',
    description: "Logical points at 1×. Export at 2×.",
    width: 834,
    height: 1194,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(24),
    columns: 8,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
  {
    id: "mobile-ipad-13",
    category: "mobile",
    family: "Tablet",
    name: 'iPad Pro 12.9" — 1024 × 1366',
    description: "Logical points at 1×. Export at 2×.",
    width: 1024,
    height: 1366,
    unit: PX,
    ppi: 72,
    bleedMm: 0,
    margin: m(24),
    columns: 8,
    gutter: 24,
    colorSpace: "rgb",
    intent: "relative",
    facingPages: false,
    pageCount: 1,
  },
];

export const PRESETS: Preset[] = [...PRINT, ...SCREEN, ...SOCIAL, ...MOBILE];

export const DEFAULT_PRESET_ID = "print-a4";

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function presetsIn(category: PresetCategory): Preset[] {
  return PRESETS.filter((p) => p.category === category);
}

/** Presets grouped for a New Document dialog: category → family → presets, in catalogue order. */
export function presetTree(): { category: PresetCategoryInfo; families: { family: string; presets: Preset[] }[] }[] {
  return PRESET_CATEGORIES.map((category) => {
    const families: { family: string; presets: Preset[] }[] = [];
    for (const preset of presetsIn(category.id)) {
      const hit = families.find((f) => f.family === preset.family);
      if (hit) hit.presets.push(preset);
      else families.push({ family: preset.family, presets: [preset] });
    }
    return { category, families };
  });
}

/** Convert a value expressed in a preset's unit to device pixels at the preset ppi. */
export function unitToPx(value: number, unit: PresetUnit, ppi: number): number {
  if (unit === "mm") return mmToPx(value, ppi);
  if (unit === "in") return inToPx(value, ppi);
  return Math.round(value);
}

export interface PresetPixels {
  widthPx: number;
  heightPx: number;
  bleedPx: number;
  marginPx: PresetMargin;
  gutterPx: number;
}

/** Everything a preset resolves to in device pixels. Single source of truth for the arithmetic. */
export function presetPixels(preset: Preset): PresetPixels {
  const { unit, ppi } = preset;
  return {
    widthPx: unitToPx(preset.width, unit, ppi),
    heightPx: unitToPx(preset.height, unit, ppi),
    bleedPx: mmToPx(preset.bleedMm, ppi),
    marginPx: {
      top: unitToPx(preset.margin.top, unit, ppi),
      right: unitToPx(preset.margin.right, unit, ppi),
      bottom: unitToPx(preset.margin.bottom, unit, ppi),
      left: unitToPx(preset.margin.left, unit, ppi),
    },
    gutterPx: unitToPx(preset.gutter, unit, ppi),
  };
}

/** Human label for the physical size, e.g. "210 × 297 mm" or "1080 × 1350 px". */
export function presetSizeLabel(preset: Preset): string {
  const round = (v: number) => String(Math.round(v * 100) / 100);
  return `${round(preset.width)} × ${round(preset.height)} ${preset.unit}`;
}

export function documentFromPreset(preset: Preset, name = "Untitled"): PressDocument {
  const px = presetPixels(preset);
  return createDocument({
    name,
    ppi: preset.ppi,
    widthPx: px.widthPx,
    heightPx: px.heightPx,
    bleedPx: px.bleedPx,
    pageCount: preset.pageCount,
    facingPages: preset.facingPages,
    margin: px.marginPx,
    mirrorMargins: preset.facingPages,
    columns: preset.columns,
    columnGutterPx: px.gutterPx,
    colorSpace: preset.colorSpace,
    intent: preset.intent,
  });
}
