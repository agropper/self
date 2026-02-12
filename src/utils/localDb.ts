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
  currentMedications?: string | null;
  patientSummary?: string | null;
  initialFile?: {
    fileName?: string;
    bucketKey?: string;
  } | null;
  fileStatusSummary?: Array<{
    fileName?: string;
    bucketKey?: string;
    chipStatus: 'indexed' | 'pending' | 'not_in_kb';
  }>;
};

type SnapshotDoc = SnapshotPayload & {
  _id: string;
  type: 'user_snapshot';
  updatedAt: string;
};

const LAST_SNAPSHOT_KEY = 'maia_last_snapshot_user';

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
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LAST_SNAPSHOT_KEY, payload.user.userId);
  }
};

export const getLastSnapshotUserId = () => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage.getItem(LAST_SNAPSHOT_KEY);
};

export const clearLastSnapshotUserId = () => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.removeItem(LAST_SNAPSHOT_KEY);
};

/** Remove local snapshot for a user (destroy IndexedDB, clear last-snapshot key if it was this user). */
export const clearUserSnapshot = async (userId: string) => {
  if (!userId) return;
  const key = `maia-user-${userId}`;
  const db = dbCache.get(key);
  if (db) {
    try {
      await db.destroy();
    } finally {
      dbCache.delete(key);
    }
  } else {
    const tempDb = new PouchDB(key);
    try {
      await tempDb.destroy();
    } finally {
      dbCache.delete(key);
    }
  }
  if (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem(LAST_SNAPSHOT_KEY) === userId) {
    window.localStorage.removeItem(LAST_SNAPSHOT_KEY);
  }
};

export const getUserSnapshot = async (userId: string) => {
  if (!userId) return null;
  const db = getUserDb(userId);
  try {
    const doc = await db.get<SnapshotDoc>('user_snapshot');
    return doc || null;
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
};

