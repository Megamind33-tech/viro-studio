import fs from "node:fs";

const factoryPath = "C:/viro studio/src/document/factory.ts";
let factory = fs.readFileSync(factoryPath, "utf8");
if (!factory.includes("export function addVectorLayer")) {
  const needle = "export function addImageFrame(";
  const i = factory.indexOf(needle);
  if (i < 0) throw new Error("addImageFrame not found");
  const insert = `export function addVectorLayer(
  doc: PressDocument,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  nodes: import("./types").PathNode[],
  opts: { closed: boolean; fill: Rgba | null; stroke: { color: Rgba; width: number } | null },
): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const layer: Layer = {
    id: uid("ly"),
    name,
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w: Math.max(4, w), h: Math.max(4, h), rotation: 0 },
    parentId: null,
    closed: opts.closed,
    nodes,
    fill: opts.fill,
    stroke: opts.stroke,
  };
  page.layers.push(layer);
  next.activeLayerIds = [layer.id];
  return next;
}

export function addGuide(doc: PressDocument, axis: "h" | "v", offset: number): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  page.guides.push({ id: uid("gd"), axis, offset });
  return next;
}

`;
  factory = factory.slice(0, i) + insert + factory.slice(i);
  fs.writeFileSync(factoryPath, factory);
  console.log("factory patched");
} else {
  console.log("factory already patched");
}
