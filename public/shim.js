// Gives the page the same small runtime it had as a claude.ai artifact (window.claude.use("db" | "user" | "sample")),
// backed by this server instead: documents over a JSON API with live updates, and the coach through /api/llm.
(function () {
  "use strict";
  const CFG = window.TS_CONFIG || { llm: { enabled: false } };
  const err = (code, message, text) => Object.assign(new Error(message || code), { code, text });

  // ---------- documents ----------
  let snap = null, rev = -1;
  const listeners = new Set();
  const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } } };
  let loading = null;
  function load() {
    loading ||= fetch("api/db", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw err("unavailable", `Server answered ${r.status}`); return r.json(); })
      .then((j) => { snap = j.collections || {}; rev = j.rev; notify(); })
      .finally(() => { loading = null; });
    return loading;
  }
  const ready = load();
  ready.catch(() => {});

  function live() {
    let es = null;
    const open = () => {
      try {
        es = new EventSource("api/events");
        es.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.rev !== rev) load().catch(() => {}); } catch {} };
      } catch {}
    };
    open();
    setInterval(() => load().catch(() => {}), 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(() => {}); });
  }
  live();

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  async function write(method, coll, id, data) {
    let r;
    try {
      r = await fetch(`api/db/${encodeURIComponent(coll)}/${encodeURIComponent(id)}`, {
        method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify({ data }),
      });
    } catch { throw err("unavailable", "Can't reach the server"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(r.status === 413 ? "quota_exceeded" : j.code || "unavailable", j.message || `Save failed (${r.status})`);
    snap ||= {};
    if (j.data == null) { if (snap[coll]) delete snap[coll][id]; }
    else (snap[coll] ||= {})[id] = j.data;
    rev = j.rev; notify();
  }

  function docRef(coll, id) {
    return {
      id,
      onSnapshot(cb, onErr) {
        const fn = () => { const v = snap?.[coll]?.[id]; cb({ id, exists: v != null, data: () => clone(v), metadata: { fromCache: false } }); };
        listeners.add(fn);
        ready.then(() => {}, (e) => onErr && onErr(e));
        if (snap) Promise.resolve().then(fn);
        return () => listeners.delete(fn);
      },
      async get() { await ready; const v = snap?.[coll]?.[id]; return { id, exists: v != null, data: () => clone(v) }; },
      set: (data) => write("PUT", coll, id, data),
      update: (data) => write("PATCH", coll, id, data),
      delete: () => write("DELETE", coll, id),
    };
  }
  function collRef(coll) {
    const docsOf = () => Object.entries(snap?.[coll] || {}).map(([id, v]) => ({ id, exists: true, data: () => clone(v) }));
    return {
      onSnapshot(cb, onErr) {
        const fn = () => { const docs = docsOf(); cb({ docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } }); };
        listeners.add(fn);
        ready.then(() => {}, (e) => onErr && onErr(e));
        if (snap) Promise.resolve().then(fn);
        return () => listeners.delete(fn);
      },
      async get() { await ready; const docs = docsOf(); return { docs, size: docs.length, empty: !docs.length }; },
      doc: (id) => docRef(coll, id || rid()),
    };
  }
  const db = Object.freeze({
    collection: collRef,
    doc(p) { const parts = String(p).split("/"); if (parts.length !== 2) throw err("bad_request", "Use collection/document paths"); return docRef(parts[0], parts[1]); },
  });

  // ---------- viewer ----------
  const user = Object.freeze({
    can: async () => true, canEdit: async () => true, isOwner: async () => true,
    id: async () => "owner", me: async () => ({ id: "owner", name: CFG.name || "" }), profiles: async () => ({}),
  });

  // ---------- coach ----------
  async function sample(input, opts = {}) {
    const msgs = typeof input === "string" ? [{ role: "user", content: input }]
      : (Array.isArray(input) ? input : []).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
    const tools = Array.isArray(opts.tools) ? opts.tools : [];
    const defs = tools.map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } }));
    let text = "", truncated = false;
    for (let round = 0; round < 8; round++) {
      let r;
      try {
        r = await fetch("api/llm", {
          method: "POST", headers: { "content-type": "application/json" }, signal: opts.signal,
          body: JSON.stringify({ messages: msgs, tools: defs.length ? defs : undefined, tier: opts.modelTier || "default" }),
        });
      } catch (e) {
        if (opts.signal?.aborted || e?.name === "AbortError") throw err("cancelled", "Cancelled", text);
        throw err("unavailable", "Can't reach the server", text);
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw err(j.code || "unavailable", j.message || `The coach failed (${r.status})`, text);
      if (j.text) { const delta = j.text; text = text ? `${text}\n\n${delta}` : delta; try { opts.onText?.({ text, delta }); } catch {} }
      truncated = !!j.truncated;
      if (!j.toolCalls?.length || !tools.length) break;
      msgs.push({ role: "assistant", content: j.text || "", toolCalls: j.toolCalls, raw: j.raw });
      for (const c of j.toolCalls) {
        const t = tools.find((x) => x.name === c.name);
        let out, isError = false;
        try {
          if (!t) throw new Error(`Unknown tool ${c.name}`);
          if (c.input && c.input.__unparsed) throw new Error("The tool arguments were not valid JSON. Send them again as a JSON object.");
          out = await t.execute(c.input || {}, { signal: opts.signal });
          out = typeof out === "string" ? out : JSON.stringify(out ?? null);
        } catch (e) { out = `Error: ${e?.message || e}`; isError = true; }
        msgs.push({ role: "tool", toolCallId: c.id, name: c.name, content: out, isError });
      }
    }
    return { text, truncated };
  }
  sample.limits = async () => ({ maxPromptBytes: 3 * 1024 * 1024, ...(CFG.llm?.tools ? { tools: { maxCount: 16 } } : {}) });
  sample.json = async (input, opts) => {
    const { text } = await sample(input, opts);
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); const s = m ? m[1] : text;
    try { return JSON.parse(s); } catch { throw err("bad_response", "The coach did not answer with JSON", text); }
  };

  window.claude = Object.freeze({
    async use(name) {
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "sample") return CFG.llm?.enabled ? sample : null;
      return null;
    },
  });
})();
