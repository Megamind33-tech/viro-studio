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

type LibraryDB = {
  assets: {
    key: string;
    value: UserAsset;
  };
  fonts: {
    key: string;
    value: UserFont;
  };
};

let dbp: Promise<IDBPDatabase<LibraryDB>> | null = null;

function db(): Promise<IDBPDatabase<LibraryDB>> {
  if (!dbp) {
    dbp = openDB<LibraryDB>("viro-press-library", 2, {
      upgrade(database, oldVersion) {
        if (!database.objectStoreNames.contains("assets")) {
          database.createObjectStore("assets", { keyPath: "id" });
        }
        if (oldVersion < 2 && !database.objectStoreNames.contains("fonts")) {
          database.createObjectStore("fonts", { keyPath: "id" });
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
