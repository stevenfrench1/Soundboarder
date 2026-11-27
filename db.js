// Tiny IndexedDB wrapper. Everything SoundBoarder keeps lives on the device:
//   pads     - pad settings (name, colour, volume, loop, fades, key)
//   sounds   - the original audio file bytes for each pad
//   settings - board-level settings (how many pads are shown)
'use strict';

const DB = (() => {
  const NAME = 'soundboarder';
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pads')) db.createObjectStore('pads', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sounds')) db.createObjectStore('sounds');
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      const r = fn(s);
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    });
  }

  return {
    getAllPads: () => tx('pads', 'readonly', (s) => s.getAll()),
    putPad: (pad) => tx('pads', 'readwrite', (s) => s.put(pad)),
    deletePad: (id) => tx('pads', 'readwrite', (s) => s.delete(id)),
    getSound: (id) => tx('sounds', 'readonly', (s) => s.get(id)),
    putSound: (id, record) => tx('sounds', 'readwrite', (s) => s.put(record, id)),
    deleteSound: (id) => tx('sounds', 'readwrite', (s) => s.delete(id)),
    getSetting: (key) => tx('settings', 'readonly', (s) => s.get(key)),
    putSetting: (key, value) => tx('settings', 'readwrite', (s) => s.put(value, key)),
  };
})();
