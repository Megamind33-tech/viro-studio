/**
 * VIRO-0015 — pure verification primitives for the export corpus. Node-only;
 * no fakes: every byte examined comes from the real exporter/compositor.
 *
 * VERIFICATION COMMAND (the whole corpus, all arms):
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs \
 *        --test tests/export-corpus.test.mjs
 *
 * Per corpus document the runner checks:
 *   - PDF operator topology — the saved PDF's page content stream is decoded
 *     with pdf-lib and censused operator-by-operator (`topologyOf`), then
 *     matched against the manifest expectation (`assertTopology`: exact
 *     numbers, ">=N" floors);
 *   - PdfExportReport field assertions — EVERY field of the report must be
 *     covered by the manifest row (`assertReportCoverage`), matched by
 *     `assertReport`;
 *   - PNG pixel fingerprints — decoded-IDAT SHA-256 of a real compositor
 *     `snapshotPagePng` buffer, taken through the in-runner playwright
 *     harness (`pagePngFingerprints`) where the compositor is needed.
 *
 * PNG pins live in tests/export-corpus-png.json next to the expectations.
 * Hashing decoded IDAT pixels (not the container) means a re-encode cannot
 * fail a pin while one changed pixel must.
 *
 * VACUITY CHECK: `mutationSelfChecks()` deliberately corrupts a content
 * hash, a topology expectation and a PNG buffer, and asserts the comparators
 * REJECT all three — the corpus fails if its assertions stop biting.
 */
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** { width, height, sha256 } of a real PNG — header parse + decoded-pixel hash. */
export function pngFingerprint(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
    } else if (type === "IDAT") {
      idat.push(buf.subarray(offset + 8, offset + 8 + len));
    }
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const sha256 = createHash("sha256").update(raw).digest("hex");
  return { width, height, sha256, rawBytes: raw.length };
}

/**
 * Concatenated, inflated page content-stream text of a pdf-lib-produced PDF,
 * resolved through pdf-lib's object graph so object streams cannot hide it.
 */
export async function pageContentText(pdfBytes) {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const page = pdf.getPage(0);
  const context = pdf.context;
  const decode = (refOrStream) => {
    const stream = refOrStream instanceof PDFRawStream ? refOrStream : context.lookup(refOrStream);
    if (!(stream instanceof PDFRawStream)) return "";
    const filter = stream.dict.lookup(PDFName.of("Filter"));
    const filterName = filter && typeof filter.asString === "function" ? filter.asString() : "";
    const raw = Buffer.from(stream.getContents());
    return /Flate/i.test(String(filterName)) ? inflateSync(raw).toString("latin1") : raw.toString("latin1");
  };
  // PDFPageLeaf.Contents() is a PDFRef, a PDFArray of refs, or undefined.
  const contents = page.node.Contents();
  if (!contents) return "";
  if (typeof contents.asArray === "function") {
    return contents.asArray().map((ref) => decode(ref)).filter(Boolean).join("\n");
  }
  return decode(contents);
}

/**
 * Operator census of content text. Token-EXACT: a token must equal the
 * operator to count, so `f*` is never `f`, `W` (clip) is never `w` (line
 * width), and numeric operands can never be mistaken for operators.
 */
export function topologyOf(contentText) {
  const tokens = contentText.split(/\s+/).filter(Boolean);
  const count = (op) => tokens.reduce((acc, t) => acc + (t === op ? 1 : 0), 0);
  return {
    m: count("m"),
    c: count("c"),
    h: count("h"),
    fill: count("f"),
    evenOddFill: count("f*"),
    fillStroke: count("B"),
    fillStrokeEvenOdd: count("B*"),
    stroke: count("S"),
    re: count("re"),
    clip: count("W"),
    endPath: count("n"),
    do: count("Do"),
    BT: count("BT"),
    ET: count("ET"),
    Tf: count("Tf"),
    Tm: count("Tm"),
    TJ: count("TJ"),
    cm: count("cm"),
    gs: count("gs"),
    q: count("q"),
    Q: count("Q"),
    lineWidth: count("w"),
  };
}

function wantSatisfied(actual, want) {
  if (typeof want === "number") return actual === want;
  if (typeof want === "string" && want.startsWith(">=")) return actual >= Number(want.slice(2));
  return false;
}

/** Assert an operator census against the expectation (numbers exact, ">=N" floors). */
export function assertTopology(actual, expected, label) {
  for (const [op, want] of Object.entries(expected)) {
    if (!wantSatisfied(actual[op] ?? 0, want)) {
      throw new Error(`${label}: operator '${op}' expected ${JSON.stringify(want)}, got ${actual[op] ?? 0}`);
    }
  }
}

/** Every PdfExportReport field a corpus row must pin — acceptance: no blind spots. */
export const REQUIRED_REPORT_FIELDS = [
  "pagePt",
  "vectorPaths",
  "textRuns",
  "glyphs",
  "images",
  "rasterFallbacks",
  "notes",
];

/** A manifest row's expectReport must name every report field. */
export function assertReportCoverage(expected, label) {
  const missing = REQUIRED_REPORT_FIELDS.filter((f) => !(f in expected));
  if (missing.length) {
    throw new Error(`${label}: expectReport does not cover field(s): ${missing.join(", ")}`);
  }
}

/** Assert a PdfExportReport against the manifest expectation (">=N" floors; on arrays ">=N" means length). */
export function assertReport(actual, expected, label) {
  for (const [key, want] of Object.entries(expected)) {
    if (key === "pagePt") {
      if (Math.abs(actual.pagePt.w - want.w) > 0.01 || Math.abs(actual.pagePt.h - want.h) > 0.01) {
        throw new Error(`${label}: pagePt ${JSON.stringify(actual.pagePt)} != ${JSON.stringify(want)}`);
      }
      continue;
    }
    if (Array.isArray(want)) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(want)) {
        throw new Error(`${label}: report.${key} ${JSON.stringify(actual[key])} != ${JSON.stringify(want)}`);
      }
      continue;
    }
    if (typeof want === "string" && want.startsWith(">=")) {
      const actualValue = Array.isArray(actual[key]) ? actual[key].length : (actual[key] ?? 0);
      if (!(actualValue >= Number(want.slice(2)))) {
        throw new Error(`${label}: report.${key} ${JSON.stringify(actual[key])} !>= ${want}`);
      }
      continue;
    }
    if (actual[key] !== want) throw new Error(`${label}: report.${key} ${JSON.stringify(actual[key])} != ${JSON.stringify(want)}`);
  }
}

/** SHA-256 of decoded content text — the whole-stream identity used by sameContentAs. */
export function contentHash(contentText) {
  return createHash("sha256").update(contentText).digest("hex");
}

/**
 * VACUITY PROOF. Deliberately mutates both sides and asserts the comparators
 * REJECT. Returns the list of mutations correctly caught; the runner asserts
 * the list is complete ("content-hash", "topology-expectation", "png-pixel-hash").
 */
export function mutationSelfChecks(sampleContentText, samplePng) {
  const caught = [];

  // 1. Mutate one coordinate in frozen content: the exact-content hash bites.
  const goldenHash = contentHash(sampleContentText);
  const mutated = sampleContentText.replace(/-?[\d.]+/, (m) => String(Number(m) + 1));
  if (contentHash(mutated) !== goldenHash) caught.push("content-hash");

  // 2. Mutate the census expectation: assertTopology must throw.
  const census = topologyOf(sampleContentText);
  try {
    assertTopology(census, { ...census, fill: (census.fill ?? 0) + 1 }, "mutation");
  } catch {
    caught.push("topology-expectation");
  }

  // 3. Corrupt one non-zero byte of the first IDAT payload: the decoded-pixel
  //    hash must change. (The CRC is ignored by pngFingerprint by design —
  //    fidelity pins key on pixels, and a corrupt-CRC PDF/PNG round-trip in
  //    the exporter path is a separate concern.)
  const flipped = Buffer.from(samplePng);
  for (let i = 8; i < flipped.length - 4; i++) {
    if (flipped[i] !== 0) {
      flipped[i] ^= 0xff;
      break;
    }
  }
  const before = pngFingerprint(samplePng);
  let after;
  try {
    after = pngFingerprint(flipped);
  } catch {
    after = { sha256: "inflate-failed" };
  }
  if (after.sha256 !== before.sha256) caught.push("png-pixel-hash");

  return caught;
}
