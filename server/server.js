// trainingsched server: serves the training page, stores its data, and relays coach requests to an LLM provider.
// No dependencies beyond Node itself. Put it behind an authenticating reverse proxy (e.g. Pangolin):
// the app has no login of its own and anyone who can reach it can read and change the data.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, validName } from "./store.js";
import { complete, listModels, LlmError, PRESETS } from "./llm.js";
import { normalizeImport } from "./importer.js";
import { openSettings, SettingsError } from "./settings.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = parseInt(process.env.PORT || "8080", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(`Can't write to the data folder ${DATA_DIR} (${e.code || e.message}).`);
  console.error(`If it is a folder on the host mounted into the container, give it to the container's user: chown -R 1000:1000 <that folder>`);
  process.exit(1);
}

const settings = openSettings(path.join(DATA_DIR, "settings.json"));
const store = openStore(path.join(DATA_DIR, "store.json"));
const seed = path.join(DATA_DIR, "seed.json");
if (store.isEmpty() && fs.existsSync(seed)) {
  const { collections } = normalizeImport(JSON.parse(fs.readFileSync(seed, "utf8")));
  store.replaceAll(collections);
  fs.renameSync(seed, `${seed}.imported`);
  console.log(`Imported ${seed}: ${JSON.stringify(store.count())}`);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const titleFor = (name) => (name ? `${name}'s Training Week` : "Training Week");
function clientConfig() {
  const LLM = settings.llm(), v = settings.view();
  return {
    name: v.name, pronoun: v.pronoun, firstRun: v.firstRun, title: titleFor(v.name),
    llm: LLM.enabled ? { enabled: true, tools: LLM.tools, provider: LLM.provider, model: LLM.model } : { enabled: false, reason: LLM.reason },
  };
}
const pageBody = fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf8");
const pageHtml = (cfg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]{display:none!important}</style>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231C2F45'/%3E%3Cpath d='M6 23l7-11 5 7 3-4 5 8z' fill='%23EEF2F7'/%3E%3C/svg%3E">
<script>window.TS_CONFIG=${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script>
<script src="shim.js"></script>
</head><body>
${pageBody.replaceAll("%%TITLE%%", esc(cfg.title))}
</body></html>`;
const shimJs = fs.readFileSync(path.join(ROOT, "public", "shim.js"), "utf8");

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === "string";
  const data = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": isBuf ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(data);
}
const fail = (res, status, code, message) => send(res, status, { code, message });

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Request too large"), { status: 413, code: "too_large" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Body is not valid JSON"), { status: 400, code: "bad_request" })); }
    });
    req.on("error", reject);
  });
}

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, pageHtml(clientConfig()), { "content-type": "text/html; charset=utf-8" });
  if (req.method === "GET" && p === "/shim.js") return send(res, 200, shimJs, { "content-type": "text/javascript; charset=utf-8" });
  if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true });
  if (req.method === "GET" && p === "/api/config") return send(res, 200, clientConfig());

  if (p === "/api/settings" && req.method === "GET") return send(res, 200, settings.view());
  if (p === "/api/settings" && req.method === "PUT") {
    const body = await readJson(req, 64 * 1024);
    try { const view = settings.update(body); logCoach(); return send(res, 200, { ...view, client: clientConfig() }); }
    catch (e) { if (e instanceof SettingsError) return fail(res, 400, "bad_request", e.message); throw e; }
  }
  if (p === "/api/settings/models" && req.method === "POST") {
    const body = await readJson(req, 64 * 1024);
    try { return send(res, 200, { models: await listModels(settings.draftConfig(body.llm)) }); }
    catch (e) {
      if (e instanceof SettingsError) return fail(res, 400, "bad_request", e.message);
      if (e instanceof LlmError) return fail(res, e.status, e.code, e.message);
      throw e;
    }
  }
  if (p === "/api/settings/test" && req.method === "POST") {
    const LLM = settings.llm();
    if (!LLM.enabled) return fail(res, 400, "not_configured", LLM.reason);
    const started = Date.now();
    const tools = LLM.tools ? [{ name: "connection_test", description: "Confirms that the connection works. Call it when asked to.", inputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }] : undefined;
    const messages = [{ role: "user", content: LLM.tools ? "This is a connection test. Call the connection_test tool with ok set to true." : "This is a connection test. Reply with the single word OK." }];
    try {
      const out = await complete(settings.llm(), { messages, tools });
      const toolUsed = !!out.toolCalls?.some((t) => t.name === "connection_test");
      return send(res, 200, { ok: true, ms: Date.now() - started, provider: LLM.provider, model: LLM.model, reply: (out.text || "").slice(0, 200), tools: LLM.tools ? (toolUsed ? "works" : "not_used") : "off" });
    } catch (e) {
      if (e instanceof LlmError) { console.warn(`Coach test failed, ${e.code}: ${e.message}`); return fail(res, e.status === 499 ? 499 : 502, e.code, e.message); }
      throw e;
    }
  }

  if (req.method === "GET" && p === "/api/db") return send(res, 200, { rev: store.rev, collections: store.snapshot() });

  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 3000\ndata: ${JSON.stringify({ rev: store.rev })}\n\n`);
    const off = store.subscribe((rev) => res.write(`data: ${JSON.stringify({ rev })}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { off(); clearInterval(ping); });
    return;
  }

  const m = p.match(/^\/api\/db\/([^/]+)\/([^/]+)$/);
  if (m) {
    const [c, id] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
    if (!validName(c) || !validName(id)) return fail(res, 400, "bad_request", "Collection and document names may only use letters, digits, - and _");
    if (req.method === "DELETE") { store.remove(c, id); return send(res, 200, { rev: store.rev, id, data: null }); }
    if (req.method === "PUT" || req.method === "PATCH") {
      const body = await readJson(req, 2 * 1024 * 1024);
      if (!isPlainObject(body.data)) return fail(res, 400, "bad_request", "Send {data: {...}}");
      const data = req.method === "PUT" ? store.set(c, id, body.data) : store.update(c, id, body.data);
      return send(res, 200, { rev: store.rev, id, data });
    }
    return fail(res, 405, "bad_request", "Method not allowed");
  }

  if (req.method === "GET" && p === "/api/export") {
    const date = new Date().toISOString().slice(0, 10);
    const NAME = settings.name();
    const slug = (NAME || "training").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const body = { format: "trainingsched", version: 1, exportedAt: new Date().toISOString(), athlete: NAME || null, counts: store.count(), collections: store.snapshot() };
    return send(res, 200, JSON.stringify(body, null, 1), { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="trainingsched-${slug}-${date}.json"` });
  }

  if (req.method === "POST" && p === "/api/import") {
    const body = await readJson(req, 40 * 1024 * 1024);
    const mode = body.mode === "replace" ? "replace" : "merge";
    let parsed;
    try { parsed = normalizeImport(body.file); }
    catch (e) { return fail(res, 400, "bad_request", e.message); }
    if (body.dryRun) return send(res, 200, { counts: parsed.counts, notes: parsed.notes });
    if (mode === "replace") store.replaceAll(parsed.collections); else store.mergeAll(parsed.collections);
    return send(res, 200, { rev: store.rev, mode, counts: parsed.counts, notes: parsed.notes, total: store.count() });
  }

  if (req.method === "POST" && p === "/api/llm") {
    const body = await readJson(req, 4 * 1024 * 1024);
    const ctl = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
    try {
      const out = await complete(settings.llm(), { messages: body.messages, tools: body.tools, tier: body.tier, signal: ctl.signal });
      return send(res, 200, out);
    } catch (e) {
      if (e instanceof LlmError) { if (e.code !== "cancelled") console.warn(`LLM ${e.code}: ${e.message}`); return fail(res, e.status, e.code, e.message); }
      throw e;
    }
  }

  return fail(res, 404, "not_found", "Not found");
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) fail(res, e.status || 500, e.code || "server_error", e.status ? e.message : "Something went wrong on the server");
    if (!e.status) console.error(e);
  });
}).listen(PORT, () => {
  console.log(`trainingsched for ${settings.name() || "(no name yet)"} on :${PORT}, data in ${DATA_DIR}`);
  logCoach();
});

function logCoach() {
  const LLM = settings.llm();
  console.log(LLM.enabled ? `Coach: ${PRESETS[LLM.provider]?.label || LLM.provider}, ${LLM.model}${LLM.tools ? "" : " (tool calling off)"}` : `Coach off: ${LLM.reason}. Set it up in the page under Settings.`);
}
