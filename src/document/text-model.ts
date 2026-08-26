import type {
  CharacterRun,
  CharacterStyle,
  ParagraphRun,
  ParagraphStyle,
  Story,
  TextContainerKind,
  TextFrameProperties,
  TextStyleRegistry,
} from "./types";

export interface TextRange {
  start: number;
  end: number;
}

export type TextAffinity = "backward" | "forward" | "none";

export function emptyTextStyles(): TextStyleRegistry {
  return { character: {}, paragraph: {} };
}

export function defaultTextFrameProperties(kind: TextContainerKind = "area"): TextFrameProperties {
  return {
    kind,
    inset: { top: 0, right: 0, bottom: 0, left: 0 },
    columns: 1,
    columnGutter: 0,
    verticalAlign: "top",
    autoSize: kind === "point" ? "both" : "none",
  };
}

/**
 * JavaScript and the DOM address strings in UTF-16 code units. We keep that
 * stable external coordinate system, but only allow public edits at grapheme
 * boundaries so a command cannot split a combining sequence or emoji cluster.
 */
export function graphemeBoundaries(text: string): number[] {
  const out = [0];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const part of segmenter.segment(text)) {
      if (part.index > 0) out.push(part.index);
    }
    if (out[out.length - 1] !== text.length) out.push(text.length);
    return out;
  }

  // Current Electron and supported browsers provide Intl.Segmenter. This
  // fallback preserves surrogate pairs and attaches common combining/emoji
  // continuations rather than falling back to unsafe code-unit iteration.
  let offset = 0;
  let joinNext = false;
  for (const scalar of Array.from(text)) {
    const at = offset;
    offset += scalar.length;
    const continuation =
      joinNext ||
      /\p{Mark}/u.test(scalar) ||
      /[\uFE00-\uFE0F]/u.test(scalar) ||
      /[\u{1F3FB}-\u{1F3FF}]/u.test(scalar);
    if (!continuation && at > 0) out.push(at);
    joinNext = scalar === "\u200D";
  }
  if (out[out.length - 1] !== text.length) out.push(text.length);
  return out;
}

export function isGraphemeBoundary(text: string, offset: number): boolean {
  return Number.isInteger(offset) && graphemeBoundaries(text).includes(offset);
}

export function assertTextRange(text: string, start: number, end: number): TextRange {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RangeError("text range offsets must be integers");
  }
  if (start < 0 || end < start || end > text.length) {
    throw new RangeError(`text range [${start}, ${end}) is outside 0..${text.length}`);
  }
  if (!isGraphemeBoundary(text, start) || !isGraphemeBoundary(text, end)) {
    throw new RangeError(`text range [${start}, ${end}) splits a grapheme cluster`);
  }
  return { start, end };
}

function styleKey(run: CharacterRun | ParagraphRun): string {
  const entries = Object.entries(run.overrides).sort(([a], [b]) => a.localeCompare(b));
  return `${run.styleId ?? ""}\u0001${JSON.stringify(entries)}`;
}

function normalizeRuns<T extends CharacterRun | ParagraphRun>(runs: readonly T[], textLength: number): T[] {
  const ordered = runs
    .filter((run) => run.start < run.end)
    .map((run) => ({ ...run, overrides: structuredClone(run.overrides) }) as T)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: T[] = [];
  for (const run of ordered) {
    if (run.start < 0 || run.end > textLength || run.end < run.start) {
      throw new RangeError(`style range [${run.start}, ${run.end}) is outside 0..${textLength}`);
    }
    const prior = out[out.length - 1];
    if (prior && run.start < prior.end) {
      throw new RangeError(`style ranges overlap at ${run.start}`);
    }
    if (prior && prior.end === run.start && styleKey(prior) === styleKey(run)) {
      prior.end = run.end;
    } else out.push(run);
  }
  return out;
}

export function normalizeCharacterRuns(runs: readonly CharacterRun[], textLength: number): CharacterRun[] {
  return normalizeRuns(runs, textLength);
}

export function normalizeParagraphRuns(runs: readonly ParagraphRun[], textLength: number): ParagraphRun[] {
  return normalizeRuns(runs, textLength);
}

function styleAt<T extends CharacterRun | ParagraphRun>(
  runs: readonly T[],
  offset: number,
  affinity: TextAffinity,
): T | undefined {
  if (affinity === "none") return undefined;
  if (affinity === "backward") {
    return [...runs].reverse().find((run) => run.start < offset && offset <= run.end) ?? runs.find((run) => run.start === offset);
  }
  return runs.find((run) => run.start <= offset && offset < run.end) ?? [...runs].reverse().find((run) => run.end === offset);
}

function replaceInRuns<T extends CharacterRun | ParagraphRun>(
  runs: readonly T[],
  oldLength: number,
  start: number,
  end: number,
  insertedLength: number,
  affinity: TextAffinity,
): T[] {
  const source = normalizeRuns(runs, oldLength);
  const inherited = insertedLength ? styleAt(source, start, affinity) : undefined;
  const delta = insertedLength - (end - start);
  const out: T[] = [];

  if (start === end) {
    for (const run of source) {
      if (run.end <= start) out.push(run);
      else if (run.start >= start) out.push({ ...run, start: run.start + delta, end: run.end + delta });
      else {
        out.push({ ...run, end: start });
        out.push({ ...run, start: start + delta, end: run.end + delta });
      }
    }
  } else {
    for (const run of source) {
      if (run.end <= start) out.push(run);
      else if (run.start >= end) out.push({ ...run, start: run.start + delta, end: run.end + delta });
      else {
        if (run.start < start) out.push({ ...run, end: start });
        if (run.end > end) out.push({ ...run, start: start + insertedLength, end: run.end + delta });
      }
    }
  }

  if (inherited && insertedLength) {
    out.push({
      ...inherited,
      start,
      end: start + insertedLength,
      overrides: structuredClone(inherited.overrides),
    });
  }
  return normalizeRuns(out, oldLength + delta);
}

export function replaceStoryRange(
  story: Story,
  start: number,
  end: number,
  replacement: string,
  affinity: TextAffinity = "backward",
): Story {
  assertTextRange(story.text, start, end);
  const nextText = story.text.slice(0, start) + replacement + story.text.slice(end);
  return {
    ...story,
    text: nextText,
    runs: replaceInRuns(story.runs ?? [], story.text.length, start, end, replacement.length, affinity),
    paragraphRuns: replaceInRuns(
      story.paragraphRuns ?? [],
      story.text.length,
      start,
      end,
      replacement.length,
      affinity,
    ),
  };
}

function subtractRange<T extends CharacterRun | ParagraphRun>(runs: readonly T[], start: number, end: number): T[] {
  const out: T[] = [];
  for (const run of runs) {
    if (run.end <= start || run.start >= end) out.push(run);
    else {
      if (run.start < start) out.push({ ...run, end: start });
      if (run.end > end) out.push({ ...run, start: end });
    }
  }
  return out;
}

export function applyCharacterRange(
  story: Story,
  start: number,
  end: number,
  overrides: Partial<CharacterStyle>,
  styleId: string | null = null,
): Story {
  assertTextRange(story.text, start, end);
  if (start === end) throw new RangeError("character formatting range must not be empty");
  const runs = subtractRange(normalizeCharacterRuns(story.runs ?? [], story.text.length), start, end);
  runs.push({ start, end, styleId, overrides: structuredClone(overrides) });
  return { ...story, runs: normalizeCharacterRuns(runs, story.text.length) };
}

export function paragraphRange(text: string, start: number, end: number): TextRange {
  assertTextRange(text, start, end);
  const paraStart = start === 0 ? 0 : text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextBreak = text.indexOf("\n", end);
  const paraEnd = nextBreak < 0 ? text.length : nextBreak + 1;
  return { start: paraStart, end: paraEnd };
}

export function applyParagraphRange(
  story: Story,
  start: number,
  end: number,
  overrides: Partial<ParagraphStyle>,
  styleId: string | null = null,
): Story {
  const range = paragraphRange(story.text, start, end);
  if (range.start === range.end) throw new RangeError("paragraph formatting needs a paragraph");
  const runs = subtractRange(normalizeParagraphRuns(story.paragraphRuns ?? [], story.text.length), range.start, range.end);
  runs.push({ ...range, styleId, overrides: structuredClone(overrides) });
  return { ...story, paragraphRuns: normalizeParagraphRuns(runs, story.text.length) };
}

export function validateStoryTextModel(story: Story): string[] {
  const errors: string[] = [];
  for (const [name, runs] of [
    ["character", story.runs ?? []],
    ["paragraph", story.paragraphRuns ?? []],
  ] as const) {
    try {
      normalizeRuns(runs, story.text.length);
    } catch (error) {
      errors.push(`${name} ranges: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const run of runs) {
      if (!isGraphemeBoundary(story.text, run.start) || !isGraphemeBoundary(story.text, run.end)) {
        errors.push(`${name} range [${run.start}, ${run.end}) splits a grapheme cluster`);
      }
    }
  }
  return errors;
}
