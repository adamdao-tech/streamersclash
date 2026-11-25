
const DB = 'recvrve', STORE = 'files';
let db = null;
function open() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
export async function idb_load() {
  try { db = await open(); } catch (e) { console.warn('IndexedDB is unavailable', e); return []; }
  return new Promise((ok) => {
    const out = [];
    const c = db.transaction(STORE).objectStore(STORE).openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return ok(out);
      out.push([cur.key, cur.value.bytes, cur.value.mtime]);
      cur.continue();
    };
    c.onerror = () => ok(out);
  });
}
export function idb_put(path, bytes, mtime) {
  if (db) db.transaction(STORE, 'readwrite').objectStore(STORE).put({ bytes, mtime }, path);
}
export function idb_delete(path) {
  if (db) db.transaction(STORE, 'readwrite').objectStore(STORE).delete(path);
}
export function pick_files(accept, multiple) {
  return new Promise((ok) => {
    const i = document.createElement('input');
    i.type = 'file';
    if (accept) i.accept = accept;
    i.multiple = multiple;
    i.style.display = 'none';
    document.body.appendChild(i);
    const done = (v) => { i.remove(); ok(v); };
    i.addEventListener('cancel', () => done([]));
    i.addEventListener('change', async () => {
      const out = [];
      for (const f of i.files) out.push([f.name, new Uint8Array(await f.arrayBuffer())]);
      done(out);
    });
    i.click();
  });
}
export function download(name, bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes]));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
export function blob_url(bytes, mime) {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
export async function fetch_bytes(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}
export function fullscreen(on) {
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen();
}
export function set_doc_title(t) { document.title = t; }
