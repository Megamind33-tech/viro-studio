/**
 * VIRO-0012 in-page measurement probe.
 *
 * Loaded into the REAL editor page via Playwright's `page.evaluate`. It touches
 * no product source: it wraps the live `Compositor.draw` instance method to time
 * every frame the app paints, keeps a requestAnimationFrame delta recorder for
 * gesture windows, and exposes deterministic document builders and a pixel
 * snapshot of the page composite.
 *
 * This file must stay dependency-free — it is serialised and executed in the
 * browser, not in Node.
 */
function installViroPerf() {
  const app = window.__press;
  if (!app) throw new Error("window.__press is missing — the editor did not boot");
  if (window.__viroPerf) return window.__viroPerf.__describe();

  const P = {
    draws: [], // { t, ms } — every Compositor.draw call
    frames: [], // rAF deltas (ms) while recording
    marks: [], // { label, t }
    recording: false,
    lastRaf: 0,
  };

  // Wrap draw on the live instance. `app.emit()` calls
  // `this.compositor?.draw(this.doc)`, so every frame the app paints — full
  // composite or overlay-only — flows through this wrapper.
  const compositor = app.compositor;
  const origDraw = compositor.draw.bind(compositor);
  compositor.draw = function timedDraw(doc) {
    const t0 = performance.now();
    try {
      return origDraw(doc);
    } finally {
      const t1 = performance.now();
      P.draws.push({ t: t1, ms: t1 - t0 });
    }
  };

  const tick = (t) => {
    if (P.recording) {
      if (P.lastRaf !== 0) P.frames.push(t - P.lastRaf);
      P.lastRaf = t;
    } else {
      P.lastRaf = 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  const SHADOW = {
    type: "drop-shadow",
    enabled: true,
    color: { r: 0, g: 0, b: 0, a: 1 },
    offsetX: 6,
    offsetY: 8,
    blur: 12,
    opacity: 0.45,
  };

  /**
   * Deterministic ~30-layer documents on the active page. Geometry is pure
   * arithmetic — no randomness — so every run composites byte-identical docs.
   * Built through the real Anchor command path (`viroAnchor.applyDetailed`),
   * exactly the mutation surface a cold caller uses.
   */
  function gridRects(count) {
    const ops = [];
    for (let i = 0; i < count; i++) {
      const col = i % 6;
      const row = Math.floor(i / 6);
      ops.push({
        op: "press.add_rect",
        reason: "perf harness grid layer",
        x: 180 + col * 363,
        y: 180 + row * 640,
        w: 300,
        h: 200,
        fill: {
          r: (0.05 + 0.09 * i) % 1,
          g: (0.15 + 0.05 * ((i * 7) % 13)) % 1,
          b: (0.3 + 0.11 * ((i * 3) % 11)) % 1,
          a: 1,
        },
        name: `perf-${String(i).padStart(2, "0")}`,
      });
    }
    return ops;
  }

  let lastBuild = null;

  /**
   * Run mutations without their per-commit repaint, then paint once.
   *
   * The setup path is the app's own (anchor batches, `setDropShadow` →
   * commit), but a 30-layer shadow document would otherwise pay 30
   * increasingly expensive full composites while being built — minutes of
   * setup noise around the actual measurement. The FINAL document and the
   * FINAL composite are exactly what the unsuppressed path would produce.
   */
  function withoutIntermediateEmits(fn) {
    const orig = app.emit.bind(app);
    app.emit = () => {};
    try {
      fn();
    } finally {
      app.emit = orig;
    }
    app.emit();
  }

  async function buildDoc(kind) {
    if (kind !== "plain30" && kind !== "shadow30") throw new Error(`unknown doc kind: ${kind}`);
    let res;
    withoutIntermediateEmits(() => {
      res = window.viroAnchor.applyDetailed(gridRects(30));
      const ids = [];
      for (const r of res) for (const id of r.created || []) ids.push(id);
      if (ids.length !== 30) throw new Error(`expected 30 created layers, got ${ids.length}`);
      if (kind === "shadow30") {
        // The same effect the desk's fx panel applies by default, through the
        // app's own mutation entry (`setDropShadow` → commit).
        for (const id of ids) app.setDropShadow(id, SHADOW);
      }
      // Gestures must start with a clean selection: a live selection turns a
      // click into a handle grab instead of a fresh pick.
      app.deselect();
    });
    app.compositor.fitToView(app.doc);
    const page = app.doc.pages.find((p) => p.id === app.doc.activePageId);
    lastBuild = { kind, layerIds: res.flatMap((r) => r.created || []), pageW: page.widthPx, pageH: page.heightPx };
    return lastBuild;
  }

  function docInfo() {
    if (!lastBuild) throw new Error("buildDoc has not run yet");
    return lastBuild;
  }

  /** Client (viewport) coordinates of a page-space point, canvas offset included. */
  function pageToClient(x, y) {
    const canvas = document.getElementById("skia");
    const rect = canvas.getBoundingClientRect();
    const s = app.compositor.pageToScreen(x, y);
    return { x: rect.left + s.x, y: rect.top + s.y };
  }

  function canvasCenterClient() {
    const canvas = document.getElementById("skia");
    const r = canvas.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** The screen point of a layer's transform corner (handle position). */
  function layerCornerClient(layerId) {
    const page = app.doc.pages.find((p) => p.id === app.doc.activePageId);
    const layer = page.layers.find((l) => l.id === layerId);
    const t = layer.transform;
    return pageToClient(t.x + t.w, t.y + t.h);
  }

  function layerCenterClient(layerId) {
    const page = app.doc.pages.find((p) => p.id === app.doc.activePageId);
    const layer = page.layers.find((l) => l.id === layerId);
    const t = layer.transform;
    return pageToClient(t.x + t.w / 2, t.y + t.h / 2);
  }

  /**
   * Idle composite cost: rAF-aligned `Compositor.draw(app.doc)` — the exact
   * call `app.emit()` makes — n samples after `warmup` discarded. Fixed work
   * per sample on a fixed document, so runs are comparable.
   */
  async function idleDraws(n, warmup = 3) {
    const out = [];
    for (let i = 0; i < warmup + n; i++) {
      await nextFrame();
      await nextFrame();
      const t0 = performance.now();
      app.compositor.draw(app.doc);
      const ms = performance.now() - t0;
      if (i >= warmup) out.push(ms);
    }
    return out;
  }

  /**
   * Pixel-exact snapshot of the page composite (the shadow path —
   * `compositePage` — with no overlay chrome). Returns the raw RGBA sha-256
   * plus a PNG for human inspection.
   */
  async function snapshotPage() {
    const ck = app.compositor.engines.ck;
    const img = app.compositor.snapshotPagePng(app.doc); // PNG bytes, page composite
    // Re-decode for an exact pixel hash: encodeToBytes alone could hide a
    // pixel difference behind encoder stability. Pixels are the proof.
    const back = ck.MakeImageFromEncoded(img);
    const info = {
      width: back.width(),
      height: back.height(),
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    };
    const pixels = back.readPixels(0, 0, info);
    const w = back.width();
    const h = back.height();
    back.delete();
    if (!pixels) throw new Error("readPixels failed on page composite");
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < img.length; i += chunk) {
      bin += String.fromCharCode.apply(null, img.subarray(i, i + chunk));
    }
    return {
      width: w,
      height: h,
      rgbaSha256: hex,
      rgbaBytes: pixels.length,
      pngBase64: btoa(bin),
    };
  }

  window.__viroPerf = {
    __describe: () => ({ installed: true }),
    app: () => app,
    reset: () => {
      P.draws.length = 0;
      P.frames.length = 0;
      P.marks.length = 0;
    },
    mark: (label) => P.marks.push({ label, t: performance.now() }),
    startFrames: () => {
      P.frames.length = 0;
      P.recording = true;
    },
    stopFrames: () => {
      P.recording = false;
    },
    /** Draws that completed after t0, excluding ones already returned. */
    drawsSince: (t0) => P.draws.filter((d) => d.t > t0).map((d) => d.ms),
    frameDeltas: () => P.frames.slice(),
    marks: () => P.marks.slice(),
    now: () => performance.now(),
    nextFrame,
    buildDoc,
    docInfo,
    idleDraws,
    snapshotPage,
    pageToClient,
    layerCenterClient,
    layerCornerClient,
    canvasCenterClient,
    setTool: (t) => app.setTool(t),
    backend: () => app.compositor.engines.backend,
    userAgent: () => navigator.userAgent,
  };
  return window.__viroPerf.__describe();
}

export { installViroPerf };
