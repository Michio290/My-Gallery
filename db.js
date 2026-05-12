/* ═══════════════════════════════════════════════════
   LOVE GALLERY — db.js  v3
   IndexedDB wrapper: foto, lagu, folder, tag, config
═══════════════════════════════════════════════════ */

const DB_NAME    = 'LoveGalleryDB';
const DB_VERSION = 3;
let   _db        = null;

function dbOpen() {
  return new Promise((resolve, reject) => {
    if (_db) { resolve(_db); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db     = e.target.result;
      const oldVer = e.oldVersion;

      if (oldVer < 1) {
        if (!db.objectStoreNames.contains('photos'))
          db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('folders'))
          db.createObjectStore('folders', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('music')) {
          const ms = db.createObjectStore('music', { keyPath: 'id', autoIncrement: true });
          ms.createIndex('name', 'name', { unique: false });
        }
        if (!db.objectStoreNames.contains('config'))
          db.createObjectStore('config', { keyPath: 'key' });
      }
      if (oldVer < 3) {
        if (!db.objectStoreNames.contains('tags'))
          db.createObjectStore('tags', { keyPath: 'id' });
      }
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return dbOpen().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

function dbPut(store, obj) {
  return dbOpen().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

function dbDelete(store, key) {
  return dbOpen().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

function dbClear(store) {
  return dbOpen().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

/* ── PHOTOS ── */
async function dbSavePhotos(photosArr) {
  await dbClear('photos');
  for (const p of photosArr) await dbPut('photos', p);
}
async function dbLoadPhotos() {
  const rows = await dbGetAll('photos');
  return rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/* ── FOLDERS ── */
async function dbSaveFolders(folderObj) {
  await dbClear('folders');
  for (const [key, arr] of Object.entries(folderObj)) {
    for (const p of arr) await dbPut('folders', { ...p, _folder: key });
  }
}
async function dbLoadFolders() {
  const rows = await dbGetAll('folders');
  const result = { game: [], her: [] };
  rows.forEach(p => {
    if (!result[p._folder]) result[p._folder] = [];
    result[p._folder].push(p);
  });
  result.game.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  result.her.sort((a, b)  => (b.ts || 0) - (a.ts || 0));
  return result;
}

/* ── MUSIC ── */
async function dbSaveMusic(track) { return dbPut('music', track); }
async function dbLoadMusic()      { return dbGetAll('music'); }
async function dbDeleteMusic(id)  { return dbDelete('music', id); }

/* ── TAGS ── */
async function dbSaveTags(tagsArr) {
  await dbClear('tags');
  for (const t of tagsArr) await dbPut('tags', t);
}
async function dbLoadTags() {
  const rows = await dbGetAll('tags');
  return rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
async function dbPutTag(tag)      { return dbPut('tags', tag); }
async function dbDeleteTag(id)    { return dbDelete('tags', id); }

/* ── CONFIG ── */
async function dbSaveConfig(key, value) {
  if (value === null) return dbDelete('config', key);
  return dbPut('config', { key, value });
}
async function dbLoadConfig(key) {
  return dbOpen().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction('config', 'readonly');
    const req = tx.objectStore('config').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror   = () => reject(req.error);
  }));
}

/* ── EXPORT / BACKUP ── */
async function dbExportBackup(includePhotos = true) {
  const [photos, folders, tags, configRows, music] = await Promise.all([
    dbLoadPhotos(), dbLoadFolders(), dbLoadTags(), dbGetAll('config'), dbLoadMusic(),
  ]);
  const backup = {
    _version: 3,
    _exportedAt: new Date().toISOString(),
    _app: 'LoveGallery',
    settings: configRows.find(c => c.key === 'settings')?.value || {},
    tags,
    photos: includePhotos ? photos : photos.map(({ src: _, ...r }) => r),
    folders: {
      game: includePhotos ? folders.game : folders.game.map(({ src: _, ...r }) => r),
      her:  includePhotos ? folders.her  : folders.her.map( ({ src: _, ...r }) => r),
    },
    // Musik disimpan dengan blob (bisa besar); hanya metadata jika includePhotos=false
    music: includePhotos
      ? music
      : music.map(({ blob: _, ...r }) => r),
    capsule: configRows.find(c => c.key === 'capsule')?.value || null,
  };
  if (backup.settings?.pin) delete backup.settings.pin;

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `lovegallery-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return backup;
}

function dbParseBackupFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = e => {
      try { resolve(JSON.parse(e.target.result)); }
      catch { reject(new Error('File JSON tidak valid')); }
    };
    r.onerror = () => reject(new Error('Gagal membaca file'));
    r.readAsText(file);
  });
}

async function dbImportBackup(backup) {
  if (backup._app !== 'LoveGallery') throw new Error('Bukan file backup LoveGallery');
  if (Array.isArray(backup.tags)   && backup.tags.length)   await dbSaveTags(backup.tags);
  if (Array.isArray(backup.photos) && backup.photos.length) await dbSavePhotos(backup.photos);
  if (backup.folders)  await dbSaveFolders(backup.folders);
  // Restore musik jika ada (hanya yang punya blob — backup lengkap)
  if (Array.isArray(backup.music) && backup.music.length) {
    await dbClear('music');
    for (const t of backup.music) {
      if (t.blob) await dbPut('music', t);
    }
  }
  if (backup.settings) {
    const current = await dbLoadConfig('settings') || {};
    await dbSaveConfig('settings', { ...backup.settings, pin: current.pin });
  }
  if (backup.capsule) await dbSaveConfig('capsule', backup.capsule);
}

/* ── PIN LOCKOUT PERSISTENCE ── */
async function dbSaveLockout(attempts, lockedUntil) {
  return dbSaveConfig('pin_lockout', { attempts, lockedUntil });
}
async function dbLoadLockout()  { return dbLoadConfig('pin_lockout'); }
async function dbClearLockout() { return dbSaveConfig('pin_lockout', null); }

/* ── Migrate dari localStorage ── */
async function dbMigrateFromLocalStorage() {
  try {
    const migrated = await dbLoadConfig('migrated_v1');
    if (migrated) return;
    console.log('🔄 Migrasi dari localStorage...');
    const rawPhotos = localStorage.getItem('lovegal');
    if (rawPhotos) { const arr = JSON.parse(rawPhotos); if (arr.length) await dbSavePhotos(arr); }
    const rawFolders = localStorage.getItem('lovegal_folders');
    if (rawFolders) await dbSaveFolders(JSON.parse(rawFolders));
    const rawCfg = localStorage.getItem('lovegal_cfg');
    if (rawCfg) await dbSaveConfig('settings', JSON.parse(rawCfg));
    await dbSaveConfig('migrated_v1', true);
    console.log('✅ Migrasi selesai!');
  } catch(e) { console.warn('Migrasi gagal:', e); }
}