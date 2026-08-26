/// <reference types="vite/client" />

declare module "*.wasm?url" {
  const src: string;
  export default src;
}

declare module "canvaskit-wasm/bin/full/canvaskit.js" {
  const init: (opts?: { locateFile?: (file: string) => string }) => Promise<import("canvaskit-wasm").CanvasKit>;
  export default init;
}

declare module "lcms-wasm" {
  export function instantiate(opts?: { locateFile?: (name: string) => string }): Promise<LcmsModule>;
  export interface LcmsModule {
    cmsCreate_sRGBProfile: () => number;
    cmsCreateLab4Profile: (wp?: number[] | null) => number;
    cmsCreateTransform: (...args: unknown[]) => number;
    cmsDoTransform: (xform: number, input: ArrayLike<number>, count: number) => ArrayLike<number>;
    cmsDeleteTransform: (xform: number) => void;
    cmsCloseProfile: (profile: number) => void;
  }
}

declare module "lcms-wasm/lib/constants.js" {
  export const TYPE_RGB_8: number;
  export const TYPE_Lab_16: number;
  export const TYPE_Lab_DBL: number;
  export const INTENT_RELATIVE_COLORIMETRIC: number;
}

interface ViroPressBridge {
  openFile: (filters?: { name: string; extensions: string[] }[]) => Promise<{ path: string; bytes: ArrayBuffer } | null>;
  saveFile: (opts: { defaultPath: string; bytes: ArrayBuffer }) => Promise<string | null>;
  listFonts?: () => Promise<
    { id: string; family: string; style: string; name: string; path: string }[]
  >;
  readFont?: (path: string) => Promise<{ path: string; bytes: ArrayBuffer } | null>;
}

declare module "opentype.js" {
  class Path {
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    close(): void;
  }
  class Glyph {
    constructor(opts: { name: string; unicode: number; advanceWidth: number; path: Path });
  }
  class Font {
    constructor(opts: {
      familyName: string;
      styleName: string;
      unitsPerEm: number;
      ascender: number;
      descender: number;
      glyphs: Glyph[];
    });
    toArrayBuffer(): ArrayBuffer;
  }
  const opentype: { Path: typeof Path; Glyph: typeof Glyph; Font: typeof Font };
  export default opentype;
}

interface Window {
  viroPress?: ViroPressBridge;
}
