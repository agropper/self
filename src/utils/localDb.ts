import PouchDBCore from 'pouchdb-core';
import PouchDBFindImport from 'pouchdb-find';
import PouchDBIdbImport from 'pouchdb-adapter-idb';

const PouchDB = (PouchDBCore as any)?.default || PouchDBCore;
const PouchDBFind = (PouchDBFindImport as any)?.default || PouchDBFindImport;
const PouchDBIdb = (PouchDBIdbImport as any)?.default || PouchDBIdbImport;

PouchDB.plugin(PouchDBIdb);
PouchDB.plugin(PouchDBFind);

type SnapshotPayload = {
  user: {
    userId: string;
    displayName?: string;
    isTemporary?: boolean;
    isAdmin?: boolean;
  };
  files?: any;
  savedChats?: any;
  currentChat?: any;
};

type SnapshotDoc = SnapshotPayload & {
  _id: string;
  type: 'user_snapshot';
  updatedAt: string;
};

const dbCache = new Map<string, PouchDB.Database>();

export const getUserDb = (userId: string): PouchDB.Database => {
  const key = `maia-user-${userId}`;
  if (!dbCache.has(key)) {
    dbCache.set(key, new PouchDB(key));
  }
  return dbCache.get(key)!;
};

const upsertDoc = async (db: PouchDB.Database, doc: Omit<SnapshotDoc, '_rev'>) => {
  try {
    const existing = await db.get(doc._id);
    return db.put({ ...doc, _rev: existing._rev });
  } catch (error: any) {
    if (error?.status === 404) {
      return db.put(doc);
    }
    throw error;
  }
};

export const saveUserSnapshot = async (payload: SnapshotPayload) => {
  if (!payload?.user?.userId) return;
  const db = getUserDb(payload.user.userId);
  const snapshot: SnapshotDoc = {
    _id: 'user_snapshot',
    type: 'user_snapshot',
    updatedAt: new Date().toISOString(),
    ...payload
  };
  await upsertDoc(db, snapshot);
};

