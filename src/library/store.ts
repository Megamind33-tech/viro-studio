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

type LibraryDB = {
  assets: {
    key: string;
    value: UserAsset;
  };
};

let dbp: Promise<IDBPDatabase<LibraryDB>> | null = null;

function db(): Promise<IDBPDatabase<LibraryDB>> {
  if (!dbp) {
    dbp = openDB<LibraryDB>("viro-press-library", 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("assets")) {
          database.createObjectStore("assets", { keyPath: "id" });
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
