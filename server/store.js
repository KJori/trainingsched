// A small document store kept in one JSON file per instance.
// Training data is tiny (hundreds of documents), so the whole store lives in memory
// and every write is flushed to disk atomically (write a temp file, then rename).
import fs from "node:fs";
import path from "node:path";

const NAME = /^[A-Za-z0-9_-]{1,100}$/;
export const validName = (s) => typeof s === "string" && NAME.test(s);

export function openStore(file) {
  let state = { collections: {} };
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    state = { collections: raw.collections || {} };
  }
  let rev = Date.now();
  const listeners = new Set();

  function flush() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    rev += 1;
    for (const fn of listeners) fn(rev);
  }

  const coll = (c) => (state.collections[c] ||= {});

  return {
    get rev() { return rev; },
    isEmpty() { return Object.values(state.collections).every((m) => !Object.keys(m).length); },
    snapshot() { return state.collections; },
    count() { return Object.fromEntries(Object.entries(state.collections).map(([k, v]) => [k, Object.keys(v).length])); },
    set(c, id, data) { coll(c)[id] = data; flush(); return coll(c)[id]; },
    update(c, id, patch) {
      const cur = { ...(coll(c)[id] || {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === "object" && v.__delete__ === true) delete cur[k];
        else cur[k] = v;
      }
      coll(c)[id] = cur; flush(); return cur;
    },
    remove(c, id) { if (state.collections[c]) delete state.collections[c][id]; flush(); },
    replaceAll(collections) { state = { collections }; flush(); },
    mergeAll(collections) {
      for (const [c, docs] of Object.entries(collections)) Object.assign(coll(c), docs);
      flush();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
