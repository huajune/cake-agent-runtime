export interface AgentTestDraftCache {
  historyText?: string;
  currentInput?: string;
  sessionId?: string;
  userId?: string;
  thinkingMode?: 'fast' | 'deep';
  thinkingBudgetTokens?: number;
}

export interface HistoryImageCacheEntry {
  dataUrl: string;
  filename?: string;
  mediaType?: string;
}

const DB_NAME = 'cake-agent-runtime-web';
const DB_VERSION = 1;
const STORE_NAME = 'agent-test-cache';
const DRAFT_KEY = 'draft';
const HISTORY_IMAGES_KEY = 'history-images';

interface CacheRecord<T> {
  key: string;
  value: T;
}

function hasIndexedDbSupport(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openAgentTestCacheDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDbSupport()) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  executor: (store: IDBObjectStore) => Promise<T>,
): Promise<T | null> {
  const db = await openAgentTestCacheDb();
  if (!db) return null;

  try {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const completionPromise = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await executor(store);

    await completionPromise;

    return result;
  } finally {
    db.close();
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getRecordValue<T>(key: string): Promise<T | null> {
  return withStore('readonly', async (store) => {
    const record = await requestToPromise<CacheRecord<T> | undefined>(store.get(key));
    return record?.value ?? null;
  });
}

async function setRecordValue<T>(key: string, value: T): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.put({ key, value }));
    return null;
  });
}

async function deleteRecord(key: string): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.delete(key));
    return null;
  });
}

export async function loadAgentTestDraftCache(): Promise<AgentTestDraftCache> {
  return (await getRecordValue<AgentTestDraftCache>(DRAFT_KEY)) ?? {};
}

export async function saveAgentTestDraftCache(draft: AgentTestDraftCache): Promise<void> {
  await setRecordValue(DRAFT_KEY, draft);
}

export async function clearAgentTestDraftCache(): Promise<void> {
  await deleteRecord(DRAFT_KEY);
}

export async function loadHistoryImageCache(): Promise<Record<string, HistoryImageCacheEntry>> {
  return (await getRecordValue<Record<string, HistoryImageCacheEntry>>(HISTORY_IMAGES_KEY)) ?? {};
}

export async function saveHistoryImageCache(
  cache: Record<string, HistoryImageCacheEntry>,
): Promise<void> {
  await setRecordValue(HISTORY_IMAGES_KEY, cache);
}

export async function clearHistoryImageCache(): Promise<void> {
  await deleteRecord(HISTORY_IMAGES_KEY);
}
