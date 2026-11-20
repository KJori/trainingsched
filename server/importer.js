// Turns an uploaded file into collections the store can hold.
// Accepts:
//  - a trainingsched export  {format:"trainingsched", collections:{...}}
//  - a bare                  {collections:{...}}
//  - the older run-only coaching page (collection "runs"), whose runs become sessions here.
import { validName } from "./store.js";

const RUN_TYPES = {
  long: { sport: "run", kind: "long" },
  easy: { sport: "run", kind: "easy" },
  variation: { sport: "run", kind: "workout" },
  race: { sport: "run", kind: "race" },
  ride: { sport: "ride", kind: "endurance" },
  other: { sport: "other", kind: "other" },
};
const KEEP = ["date", "km", "durationS", "elapsedS", "elevGain", "elevLoss", "avgHr", "maxHr", "avgPower", "np", "p20", "avgCad", "rpe", "feel", "niggle", "notes", "profile", "fileName", "createdAt", "updatedAt"];

function runToSession(r) {
  const t = RUN_TYPES[r.type] || RUN_TYPES.other;
  const s = { sport: t.sport, kind: t.kind, where: t.sport === "ride" ? (r.where || "outdoor") : null };
  for (const k of KEEP) if (r[k] !== undefined) s[k] = r[k];
  return s;
}

export function normalizeImport(file) {
  if (!file || typeof file !== "object") throw new Error("That file isn't a training export.");
  const src = file.collections;
  if (!src || typeof src !== "object" || Array.isArray(src)) throw new Error("No training data found in that file (it has no \"collections\").");
  const out = {}; const notes = [];
  for (const [c, docs] of Object.entries(src)) {
    if (!validName(c) || !docs || typeof docs !== "object" || Array.isArray(docs)) { notes.push(`Skipped "${c}": not a valid collection.`); continue; }
    for (const [id, data] of Object.entries(docs)) {
      if (!validName(id) || !data || typeof data !== "object" || Array.isArray(data)) { notes.push(`Skipped ${c}/${id}: not a valid document.`); continue; }
      if (c === "runs") { (out.sessions ||= {})[id] = runToSession(data); continue; }
      if (c === "config" && id === "main" && src.runs) continue; // old run page: easy-HR setting, not used here
      if (c === "coaching" && id === "latest" && data.runsCount != null && data.count == null) { (out.coaching ||= {})[id] = { text: data.text, createdAt: data.createdAt, count: data.runsCount }; continue; }
      (out[c] ||= {})[id] = data;
    }
  }
  if (src.runs) notes.push(`Converted ${Object.keys(src.runs).length} runs from the run coaching page into sessions.`);
  const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.keys(v).length]));
  if (!Object.keys(counts).length) throw new Error("That file contains no documents to import.");
  return { collections: out, counts, notes };
}
