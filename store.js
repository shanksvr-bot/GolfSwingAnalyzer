// store.js: saved swings in IndexedDB.
// Two object stores so the list screen never loads video blobs:
//   meta: { id, name, view, date, created, hasVideo, hasAnalysis, tempo, size }
//   data: { id, blob, analysis }

const DB_NAME = 'gsa';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'id' });
        req.result.createObjectStore('data', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const wrap = req =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = tx =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted (device may be out of space).'));
  });

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Create or update a swing. Passing an existing id keeps its name/date unless overridden.
export async function saveSwing({ id, name, view, blob, analysis }) {
  const d = await db();
  const old = id ? await wrap(d.transaction('meta').objectStore('meta').get(id)) : null;
  const meta = {
    id: id || newId(),
    name: name ?? old?.name ?? 'Swing',
    view: view ?? old?.view ?? '',
    date: old?.date ?? new Date().toISOString(),
    created: old?.created ?? Date.now(),
    hasVideo: true,
    hasAnalysis: !!analysis,
    tempo: analysis?.tempo?.ratio ?? null,
    size: blob.size,
  };
  const tx = d.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('meta').put(meta);
  tx.objectStore('data').put({ id: meta.id, blob, analysis: analysis || null });
  await txDone(tx);
  return meta;
}

// Entries from the old localStorage version had a name/date but no video.
export async function saveLegacy({ name, view, date }) {
  const d = await db();
  const tx = d.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({
    id: newId(), name, view, date, created: 0,
    hasVideo: false, hasAnalysis: false, tempo: null, size: 0,
  });
  await txDone(tx);
}

export async function listSwings() {
  const d = await db();
  const all = await wrap(d.transaction('meta').objectStore('meta').getAll());
  return all.sort((a, b) => b.created - a.created);
}

export async function getSwing(id) {
  const d = await db();
  const tx = d.transaction(['meta', 'data']);
  const [meta, data] = await Promise.all([
    wrap(tx.objectStore('meta').get(id)),
    wrap(tx.objectStore('data').get(id)),
  ]);
  return meta ? { meta, blob: data?.blob || null, analysis: data?.analysis || null } : null;
}

export async function deleteSwing(id) {
  const d = await db();
  const tx = d.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('meta').delete(id);
  tx.objectStore('data').delete(id);
  await txDone(tx);
}

// Ask the browser not to evict our data. Installed (Add to Home Screen) PWAs are the most reliable on iOS.
export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
