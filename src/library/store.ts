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
  /** Single-slot key. The app keeps one recovery record for the active session. */
  id: "current";
  /** Serialised PressDocument (structured-clone safe). */
  doc: unknown;
  /** Document name at the time of the snapshot, for the recovery prompt. */
  name: string;
  savedAt: number;
}

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
};

let dbp: Promise<IDBPDatabase<LibraryDB>> | null = null;

function db(): Promise<IDBPDatabase<LibraryDB>> {
  if (!dbp) {
    dbp = openDB<LibraryDB>("viro-press-library", 3, {
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

export async function getRecovery(): Promise<RecoverySnapshot | undefined> {
  try {
    return await (await db()).get("recovery", "current");
  } catch {
    return undefined;
  }
}

export async function deleteRecovery(): Promise<void> {
  try {
    await (await db()).delete("recovery", "current");
  } catch {
    // Blocked/private-mode IndexedDB — nothing durable to clear.
  }
}
