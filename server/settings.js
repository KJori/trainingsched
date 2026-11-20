// Settings made in the page: the athlete's name and pronoun, and the coach's provider, model and key.
// Kept in their own file next to the training data, never in exports. Anything not set here falls back
// to the environment variables (ATHLETE_NAME, ATHLETE_PRONOUN, LLM_*), so both ways of configuring work.
import fs from "node:fs";
import { PRESETS, defaultBase, llmConfig } from "./llm.js";

const originOf = (u) => { try { return new URL(u).origin; } catch { return ""; } };
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

export class SettingsError extends Error {}

export function openSettings(file, env = process.env) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
  catch (e) { if (e.code !== "ENOENT") console.warn(`Couldn't read ${file}, starting with empty settings: ${e.message}`); }

  function persist() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const envLlm = () => ({ provider: (env.LLM_PROVIDER || "").trim().toLowerCase(), base: env.LLM_BASE_URL || "", key: env.LLM_API_KEY || "" });

  // The key is only used for the server it was entered for, so changing the address can't send it somewhere else.
  function keyFor(s, base) {
    if (s.key && s.keyOrigin === originOf(base)) return { key: s.key, source: "page" };
    const e = envLlm();
    if (e.key && e.provider === s.provider && originOf(e.base || defaultBase(e.provider, env)) === originOf(base)) return { key: e.key, source: "env" };
    return { key: "", source: null };
  }

  // Settings for one provider: the saved ones, or a draft from the page laid over them.
  function resolve(draft) {
    const s = { ...(saved.llm || {}), ...(draft || {}) };
    const provider = s.provider || "";
    const base = (s.baseUrl || defaultBase(provider, env)).replace(/\/+$/, "");
    const k = draft && typeof draft.key === "string" && draft.key ? { key: draft.key, source: "draft" } : keyFor(saved.llm?.provider === provider ? { ...saved.llm, provider } : { provider }, base);
    return { s, provider, base, ...k };
  }

  let cache = null;
  function llm() {
    if (cache) return cache;
    if (!saved.llm) return (cache = llmConfig(env));
    const { s, provider, base, key } = resolve();
    if (!provider) return (cache = { enabled: false, reason: "The coach is switched off" });
    return (cache = llmConfig({
      LLM_PROVIDER: provider, LLM_MODEL: s.model || "", LLM_MODEL_QUICK: s.quickModel || "", LLM_BASE_URL: base, LLM_API_KEY: key,
      LLM_TOOLS: s.tools === false ? "false" : "true",
      LLM_MAX_TOKENS: env.LLM_MAX_TOKENS, LLM_TIMEOUT_MS: env.LLM_TIMEOUT_MS, LLM_MAX_TOKENS_FIELD: env.LLM_MAX_TOKENS_FIELD,
    }));
  }

  // A provider config for listing models before the settings are saved.
  function draftConfig(draft) {
    const { provider, base, key } = resolve(draft);
    if (!PRESETS[provider]) throw new SettingsError("Choose a provider first");
    return { provider, kind: PRESETS[provider].kind, base, key };
  }

  const name = () => str(saved.name ?? env.ATHLETE_NAME ?? "", 40) || "";
  const pronoun = () => (/^she$/i.test(saved.pronoun ?? env.ATHLETE_PRONOUN ?? "") ? "she" : "he");

  function view() {
    const cfg = llm();
    const fromPage = !!saved.llm;
    const e = envLlm();
    const provider = fromPage ? saved.llm.provider || "" : PRESETS[e.provider] ? e.provider : "";
    const s = fromPage ? saved.llm : { model: env.LLM_MODEL || "", quickModel: env.LLM_MODEL_QUICK || "", baseUrl: env.LLM_BASE_URL || "", tools: !/^(0|false|no|off)$/i.test(env.LLM_TOOLS || "true") };
    const base = (s.baseUrl || defaultBase(provider, env)).replace(/\/+$/, "");
    const k = provider ? (fromPage ? keyFor({ ...saved.llm, provider }, base) : { key: e.key, source: e.key ? "env" : null }) : { key: "", source: null };
    const staleKey = fromPage && !!saved.llm.key && saved.llm.keyOrigin !== originOf(base);
    return {
      firstRun: !name() && !saved.done,
      name: name(), pronoun: pronoun(),
      llm: {
        provider, model: s.model || "", quickModel: s.quickModel || "", baseUrl: s.baseUrl || "", tools: s.tools !== false,
        defaultBase: provider ? defaultBase(provider, env) : "",
        key: { set: !!k.key, hint: k.key ? `…${k.key.slice(-4)}` : "", source: k.source, stale: staleKey },
        enabled: !!cfg.enabled, reason: cfg.enabled ? "" : cfg.reason || "", source: fromPage ? "page" : provider ? "env" : null,
      },
      providers: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, needsKey: !p.keyless, defaultBase: defaultBase(id, env), keyOptional: !!p.keyless && id !== "ollama" })),
    };
  }

  function update(patch) {
    if (!patch || typeof patch !== "object") throw new SettingsError("Send the settings as an object");
    const next = JSON.parse(JSON.stringify(saved));
    if (patch.name !== undefined) next.name = str(patch.name, 40) ?? "";
    if (patch.pronoun !== undefined) { if (!["he", "she"].includes(patch.pronoun)) throw new SettingsError("Pronoun is he or she"); next.pronoun = patch.pronoun; }
    if (patch.done) next.done = true;
    if (patch.llm !== undefined) {
      const l = patch.llm || {};
      const provider = str(l.provider, 40) ?? "";
      if (provider && !PRESETS[provider]) throw new SettingsError(`Unknown provider "${provider}"`);
      const baseUrl = str(l.baseUrl, 300) ?? "";
      if (baseUrl && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new SettingsError("The server address should start with http:// or https://");
      const prev = saved.llm || {};
      const llmNext = { provider, model: str(l.model, 200) ?? "", quickModel: str(l.quickModel, 200) ?? "", baseUrl, tools: l.tools !== false };
      const base = (baseUrl || defaultBase(provider, env)).replace(/\/+$/, "");
      if (typeof l.key === "string" && l.key.trim()) { llmNext.key = l.key.trim().slice(0, 1000); llmNext.keyOrigin = originOf(base); }
      else if (l.key !== null && prev.key) { llmNext.key = prev.key; llmNext.keyOrigin = prev.keyOrigin; }
      next.llm = llmNext;
    }
    saved = next; cache = null; persist();
    return view();
  }

  return { llm, view, update, draftConfig, name, pronoun };
}
