import type { PressDocument } from "./types";
import { cloneDoc } from "./factory";

export class History {
  private undoStack: { label: string; doc: PressDocument }[] = [];
  private redoStack: { label: string; doc: PressDocument }[] = [];
  private named: { id: string; label: string; doc: PressDocument }[] = [];

  snapshot(label: string, doc: PressDocument): void {
    this.undoStack.push({ label, doc: cloneDoc(doc) });
    this.redoStack = [];
    if (this.undoStack.length > 80) this.undoStack.shift();
  }

  undo(current: PressDocument): PressDocument | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push({ label: "Redo", doc: cloneDoc(current) });
    return prev.doc;
  }

  redo(current: PressDocument): PressDocument | null {
    const nxt = this.redoStack.pop();
    if (!nxt) return null;
    this.undoStack.push({ label: "Undo", doc: cloneDoc(current) });
    return nxt.doc;
  }

  labels(): string[] {
    return this.undoStack.map((s) => s.label).reverse();
  }

  nameSnapshot(label: string, doc: PressDocument): void {
    this.named.push({ id: `h_${this.named.length}`, label, doc: cloneDoc(doc) });
  }

  namedList(): { id: string; label: string }[] {
    return this.named.map(({ id, label }) => ({ id, label }));
  }
}
