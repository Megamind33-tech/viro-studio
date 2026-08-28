import { openDB, type IDBPDatabase } from "idb";

export interface UserAsset {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
  width: number;
  height: number;
  addedAt: number;
}

export interface UserFont {
  id: string;
  name: string;
  family: string;
  style: string;
  bytes: ArrayBuffer;
  addedAt: number;
}

/**
 * A durable copy of the working document so an accidental reload, tab crash or
 * navigation does not discard unsaved edits. There is no server; this local
 * snapshot is the only safety net between explicit `.press.json` saves.
 */
export interface RecoverySnapshot {
  /**
   * Document identity (VIRO-0011). Autosaves key the record to the working
   * document's project id (`proj_*`), so editing document B never overwrites
   * document A's snapshot. The legacy single-slot key `"current"` is still
   * read so snapshots written before identity recovery remain recoverable.
   */
  id: string;
  /** Serialised PressDocument (structured-clone safe). */
  doc: unknown;
  /** Document name at the time of the snapshot, for the recovery prompt. */
  name: string;
  savedAt: number;
  /**
   * Project creation timestamp carried from the session that wrote the
   * snapshot, so a restore can resume the SAME project record (identity
   * preservation, critic P3-2). Absent on legacy `"current"` records.
   */
  createdAt?: number;
}

/**
 * A saved project (a document the user has kept). This is the local-first
 * document model that the cloud provider (ADR 0004) later syncs: same shape,
 * different backend. The thumbnail is a real PNG rendered from the document
 * page (GOVERNOR.md §15/§61), never stock art.
 */
export interface ProjectRecord {
  id: string;
  name: string;
  /** Serialised PressDocument (structured-clone safe). */
  doc: unknown;
  /** PNG data URL rendered from the actual page, or null when not yet rendered. */
  thumbnail: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Project metadata without the (potentially large) document body. */
export type ProjectSummary = Omit<ProjectRecord, "doc">;

type LibraryDB = {
  assets: {
    key: string;
    value: UserAsset;
  };
  fonts: {
    key: string;
    value: UserFont;
  };
  recovery: {
    key: string;
    value: RecoverySnapshot;
  };
  documents: {
    key: string;
    value: ProjectRecord;
    indexes: { updatedAt: number };
  };
};

let dbp: Promise<IDBPDatabase<LibraryDB>> | null = null;

function db(): Promise<IDBPDatabase<LibraryDB>> {
  if (!dbp) {
    dbp = openDB<LibraryDB>("viro-press-library", 4, {
      upgrade(database, oldVersion) {
        if (!database.objectStoreNames.contains("assets")) {
          database.createObjectStore("assets", { keyPath: "id" });
        }
        if (oldVersion < 2 && !database.objectStoreNames.contains("fonts")) {
          database.createObjectStore("fonts", { keyPath: "id" });
        }
        if (oldVersion < 3 && !database.objectStoreNames.contains("recovery")) {
          database.createObjectStore("recovery", { keyPath: "id" });
        }
        if (oldVersion < 4 && !database.objectStoreNames.contains("documents")) {
          const docs = database.createObjectStore("documents", { keyPath: "id" });
          docs.createIndex("updatedAt", "updatedAt");
        }
      },
    });
  }
  return dbp;
}

export async function listUserAssets(): Promise<UserAsset[]> {
  const rows = await (await db()).getAll("assets");
  return rows.sort((a, b) => b.addedAt - a.addedAt);
}

export async function putUserAsset(asset: UserAsset): Promise<void> {
  await (await db()).put("assets", asset);
}

export async function deleteUserAsset(id: string): Promise<void> {
  await (await db()).delete("assets", id);
}

export async function listUserFonts(): Promise<UserFont[]> {
  try {
    const rows = await (await db()).getAll("fonts");
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function putUserFont(font: UserFont): Promise<void> {
  await (await db()).put("fonts", font);
}

export async function deleteUserFont(id: string): Promise<void> {
  await (await db()).delete("fonts", id);
}

export async function putRecovery(snapshot: RecoverySnapshot): Promise<void> {
  await (await db()).put("recovery", snapshot);
}

/**
 * Every recovery snapshot, newest first. The store is keyed by document
 * identity (VIRO-0011), so this lists one record per document rather than a
 * single slot.
 */
export async function listRecovery(): Promise<RecoverySnapshot[]> {
  try {
    const rows = await (await db()).getAll("recovery");
    return rows.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/**
 * Read one recovery snapshot. With `id`, the record for that exact document
 * identity; without, the NEWEST record in the store — the legacy single-slot
 * read kept for the existing recover-bar flow (no-arg callers always acted on
 * the one record there was).
 */
export async function getRecovery(id?: string): Promise<RecoverySnapshot | undefined> {
  try {
    const dbh = await db();
    if (id !== undefined) return await dbh.get("recovery", id);
    const rows = await dbh.getAll("recovery");
    return rows.sort((a, b) => b.savedAt - a.savedAt)[0];
  } catch {
    return undefined;
  }
}

/** Delete one recovery record. Defaults to the legacy single-slot key. */
export async function deleteRecovery(id: string = "current"): Promise<void> {
  try {
    await (await db()).delete("recovery", id);
  } catch {
    // Blocked/private-mode IndexedDB — nothing durable to clear.
  }
}

// ── Projects (local documents) ────────────────────────────────────────────

/** Project summaries (no document body), newest-updated first. */
export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  try {
    const rows = await (await db()).getAll("documents");
    return rows
      .map(({ doc: _doc, ...summary }) => summary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  try {
    return await (await db()).get("documents", id);
  } catch {
    return undefined;
  }
}

export async function putProject(record: ProjectRecord): Promise<void> {
  await (await db()).put("documents", record);
}

export async function deleteProject(id: string): Promise<void> {
  try {
    await (await db()).delete("documents", id);
  } catch {
    // Blocked/private-mode IndexedDB — nothing durable to delete.
  }
}
