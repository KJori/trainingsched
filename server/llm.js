// One coach, many model providers.
//
// The page talks to /api/llm in a provider-neutral format:
//   messages: [{role:"user", content}, {role:"assistant", content, toolCalls, raw}, {role:"tool", toolCallId, name, content, isError}]
//   tools:    [{name, description, inputSchema}]
// and gets back {text, toolCalls:[{id,name,input}], raw, truncated}.
// Tools run in the browser (they create proposal cards); this file only translates
// between that format and each provider's API, and keeps the API key on the server.

export const PRESETS = {
  anthropic:  { label: "Anthropic (Claude)", kind: "anthropic", base: "https://api.anthropic.com/v1" },
  openai:     { label: "OpenAI", kind: "openai", base: "https://api.openai.com/v1", maxTokensField: "max_completion_tokens" },
  mistral:    { label: "Mistral", kind: "openai", base: "https://api.mistral.ai/v1" },
  deepseek:   { label: "DeepSeek", kind: "openai", base: "https://api.deepseek.com" },
  gemini:     { label: "Google Gemini", kind: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai" },
  openrouter: { label: "OpenRouter", kind: "openai", base: "https://openrouter.ai/api/v1" },
  ollama:     { label: "Ollama (local)", kind: "openai", base: "http://localhost:11434/v1", keyless: true },
  openai_compatible: { label: "Other OpenAI-compatible server", kind: "openai", base: "", keyless: true },
};

// Inside the Docker image, "localhost" is the container itself, so Ollama on the host is reached through host.docker.internal.
export function defaultBase(provider, env = process.env) {
  if (provider === "ollama" && env.TS_DOCKER) return "http://host.docker.internal:11434/v1";
  return PRESETS[provider]?.base || "";
}

export function llmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER || "").trim().toLowerCase();
  if (!provider || provider === "none") return { enabled: false, reason: "No provider is chosen" };
  const preset = PRESETS[provider];
  if (!preset) return { enabled: false, reason: `Unknown LLM_PROVIDER "${provider}". Use one of: ${Object.keys(PRESETS).join(", ")}` };
  const cfg = {
    enabled: true,
    provider,
    kind: preset.kind,
    base: (env.LLM_BASE_URL || defaultBase(provider, env)).replace(/\/+$/, ""),
    key: env.LLM_API_KEY || "",
    model: env.LLM_MODEL || "",
    quickModel: env.LLM_MODEL_QUICK || "",
    maxTokens: Math.max(256, Math.min(16000, parseInt(env.LLM_MAX_TOKENS || "2000", 10) || 2000)),
    timeoutMs: Math.max(10000, parseInt(env.LLM_TIMEOUT_MS || "180000", 10) || 180000),
    tools: !/^(0|false|no|off)$/i.test(env.LLM_TOOLS || "true"),
    maxTokensField: env.LLM_MAX_TOKENS_FIELD || preset.maxTokensField || "max_tokens",
  };
  if (!cfg.base) return { enabled: false, reason: "A server address is needed for this provider" };
  if (!cfg.key && !preset.keyless) return { enabled: false, reason: "No API key is set" };
  if (!cfg.model) return { enabled: false, reason: "No model is chosen" };
  return cfg;
}

export class LlmError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

function errorFromStatus(status, detail) {
  let msg = detail || "";
  try { const j = JSON.parse(msg); const e = Array.isArray(j) ? j[0]?.error || j[0] : j.error || j; msg = (typeof e === "string" ? e : e?.message || j.message || j.detail || msg); } catch {}
  msg = String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 300);
  if (status === 429) return new LlmError("rate_limited", `The model provider is rate limiting requests. ${msg}`, 429);
  if (status === 401 || status === 403) return new LlmError("auth_failed", `The model provider refused the API key. ${msg}`, 502);
  if (status === 400 || status === 404 || status === 422) return new LlmError("bad_request", `The model provider rejected the request. ${msg}`, 502);
  return new LlmError("unavailable", `The model provider returned an error (${status}). ${msg}`, 502);
}

async function post(cfg, url, headers, body, signal, method = "POST") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), cfg.timeoutMs);
  const onAbort = () => ctl.abort(new Error("cancelled"));
  signal?.addEventListener("abort", onAbort);
  try {
    let res;
    try {
      res = await fetch(url, { method, headers: method === "GET" ? headers : { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      if (signal?.aborted) throw new LlmError("cancelled", "Request cancelled", 499);
      if (ctl.signal.aborted) throw new LlmError("unavailable", `The model provider did not answer within ${Math.round(cfg.timeoutMs / 1000)} s.`, 504);
      throw new LlmError("unavailable", `Could not reach the model provider at ${new URL(url).origin}: ${e.message}`, 502);
    }
    const text = await res.text();
    if (!res.ok) throw errorFromStatus(res.status, text);
    try { return JSON.parse(text); } catch { throw new LlmError("unavailable", "The model provider sent a response that isn't JSON.", 502); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------- Anthropic Messages API ----------
function toAnthropic(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: String(m.content ?? "") }]);
    else if (m.role === "assistant") {
      if (m.raw?.provider === "anthropic" && Array.isArray(m.raw.content)) push("assistant", m.raw.content);
      else push("assistant", [
        ...(m.content ? [{ type: "text", text: String(m.content) }] : []),
        ...(m.toolCalls || []).map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input || {} })),
      ]);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: String(m.content ?? ""), ...(m.isError ? { is_error: true } : {}) }]);
    }
  }
  return out;
}

async function callAnthropic(cfg, { messages, tools, model, signal }) {
  const body = { model, max_tokens: cfg.maxTokens, messages: toAnthropic(messages) };
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema || { type: "object", properties: {} } }));
  const data = await post(cfg, `${cfg.base}/messages`, { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" }, body, signal);
  const blocks = Array.isArray(data.content) ? data.content : [];
  return {
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim(),
    toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
    raw: { provider: "anthropic", content: blocks },
    truncated: data.stop_reason === "max_tokens",
  };
}

// ---------- OpenAI-compatible Chat Completions (OpenAI, Mistral, DeepSeek, Gemini, OpenRouter, Ollama, ...) ----------
function toOpenAI(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      const last = out[out.length - 1];
      if (last && last.role === "user") last.content += `\n\n${m.content ?? ""}`;
      else out.push({ role: "user", content: String(m.content ?? "") });
    } else if (m.role === "assistant") {
      const r = m.raw?.provider === "openai" ? m.raw.message : null;
      const toolCalls = r?.tool_calls || (m.toolCalls || []).map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input || {}) } }));
      const msg = { role: "assistant", content: r ? (r.content ?? null) : (m.content || null) };
      if (toolCalls?.length) {
        msg.tool_calls = toolCalls;
        // Reasoning models (e.g. DeepSeek in thinking mode) need their reasoning back within a tool loop.
        if (r?.reasoning_content) msg.reasoning_content = r.reasoning_content;
      }
      if (msg.content == null && !msg.tool_calls) msg.content = "";
      out.push(msg);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: String(m.content ?? "") });
    }
  }
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text : "")).join("");
  return "";
}

async function callOpenAI(cfg, { messages, tools, model, signal }) {
  const body = { model, messages: toOpenAI(messages), stream: false, [cfg.maxTokensField]: cfg.maxTokens };
  if (tools?.length) body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.inputSchema || { type: "object", properties: {} } } }));
  const headers = cfg.key ? { authorization: `Bearer ${cfg.key}` } : {};
  const data = await post(cfg, `${cfg.base}/chat/completions`, headers, body, signal);
  const choice = data.choices?.[0];
  if (!choice?.message) throw new LlmError("unavailable", "The model provider sent an empty answer.", 502);
  const msg = choice.message;
  const toolCalls = (msg.tool_calls || []).map((t, i) => {
    let input = {};
    const args = t.function?.arguments;
    if (args && typeof args === "object") input = args;
    else if (args) { try { input = JSON.parse(args); } catch { input = { __unparsed: String(args) }; } }
    return { id: t.id || `call_${i}`, name: t.function?.name || "", input };
  });
  const keep = { role: "assistant", content: msg.content ?? null };
  if (msg.tool_calls) keep.tool_calls = msg.tool_calls.map((t, i) => ({ id: t.id || `call_${i}`, type: "function", function: { name: t.function?.name, arguments: typeof t.function?.arguments === "string" ? t.function.arguments : JSON.stringify(t.function?.arguments || {}) } }));
  if (msg.reasoning_content) keep.reasoning_content = msg.reasoning_content;
  return {
    text: textOf(msg.content).trim(),
    toolCalls,
    raw: { provider: "openai", message: keep },
    truncated: choice.finish_reason === "length",
  };
}

export async function complete(cfg, { messages, tools, tier, signal }) {
  if (!cfg.enabled) throw new LlmError("not_configured", cfg.reason || "No model provider configured", 503);
  if (!Array.isArray(messages) || !messages.length) throw new LlmError("bad_request", "messages is empty", 400);
  const model = tier === "quick" && cfg.quickModel ? cfg.quickModel : cfg.model;
  const useTools = cfg.tools && Array.isArray(tools) && tools.length ? tools.slice(0, 16) : undefined;
  return cfg.kind === "anthropic"
    ? callAnthropic(cfg, { messages, tools: useTools, model, signal })
    : callOpenAI(cfg, { messages, tools: useTools, model, signal });
}

// Model names the provider offers to this key, for the settings page. Chat models only, as far as the name tells.
export async function listModels(cfg, { signal } = {}) {
  if (!cfg.base) throw new LlmError("not_configured", "A server address is needed for this provider", 400);
  if (!cfg.key && !PRESETS[cfg.provider]?.keyless) throw new LlmError("not_configured", "Enter the API key first", 400);
  const headers = cfg.kind === "anthropic"
    ? { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" }
    : cfg.key ? { authorization: `Bearer ${cfg.key}` } : {};
  const url = `${cfg.base}/models${cfg.kind === "anthropic" ? "?limit=1000" : ""}`;
  const data = await post({ ...cfg, timeoutMs: 20000 }, url, headers, null, signal, "GET");
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  const skip = /embed|moderation|whisper|tts|dall-e|image|transcribe|audio|realtime|ocr|rerank|guard|search-preview|computer-use/i;
  const ids = list.map((m) => String(m?.id || m?.name || m || "").replace(/^models\//, "")).filter((id) => id && !skip.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 2000);
}
