// Run with: npm test   (Node 20+, no dependencies)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockLlm } from "./mock-llm.js";
import { normalizeImport } from "../server/importer.js";
import { llmConfig } from "../server/llm.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function startApp(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, "server/server.js")], { env: { ...process.env, ...env, PORT: String(port), DATA_DIR: dir }, stdio: "pipe" });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, opts = {}) => { const r = await fetch(base + p, { ...opts, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
  return { base, api, dir, stop: () => child.kill() };
}

let mock, anthropicApp, openaiApp, plainApp;
before(async () => {
  mock = await startMockLlm({ toolInput: () => ({ scope: "this_week", summary: "test", days: [[], [], [], [], [], [], []] }) });
  anthropicApp = await startApp({ ATHLETE_NAME: "Sam", ATHLETE_PRONOUN: "she", LLM_PROVIDER: "anthropic", LLM_MODEL: "m-a", LLM_API_KEY: "k-a", LLM_BASE_URL: `${mock.url}/v1` });
  openaiApp = await startApp({ ATHLETE_NAME: "Alex", LLM_PROVIDER: "deepseek", LLM_MODEL: "m-o", LLM_API_KEY: "k-o", LLM_BASE_URL: `${mock.url}/v1` });
  plainApp = await startApp({ LLM_PROVIDER: "" });
});
after(() => { for (const a of [anthropicApp, openaiApp, plainApp]) a?.stop(); mock?.server.close(); });

test("page is served with the athlete's name and config, coach off without provider", async () => {
  const html = await (await fetch(anthropicApp.base + "/")).text();
  assert.match(html, /<title>Sam(&#39;|')s Training Week<\/title>/);
  assert.match(html, /"pronoun":"she"/);
  assert.doesNotMatch(html, /%%TITLE%%/);
  assert.doesNotMatch(html, /googleapis|gstatic/, "no requests to other sites");
  const css = await (await fetch(anthropicApp.base + "/fonts.css")).text();
  const font = css.match(/url\((fonts\/[^)]+\.woff2)\)/)[1];
  const fr = await fetch(anthropicApp.base + "/" + font);
  assert.equal(fr.headers.get("content-type"), "font/woff2");
  assert.equal((await fetch(anthropicApp.base + "/fonts/../server/llm.js")).status, 404);
  const cfg = (await plainApp.api("/api/config")).body;
  assert.equal(cfg.llm.enabled, false);
  assert.equal((await plainApp.api("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })).body.code, "not_configured");
});

test("documents: set, update with field delete, list, delete", async () => {
  const { api } = plainApp;
  assert.equal((await api("/api/db/sessions/s1", { method: "PUT", body: JSON.stringify({ data: { date: "2026-11-20", km: 5, rpe: 3 } }) })).status, 200);
  const up = await api("/api/db/sessions/s1", { method: "PATCH", body: JSON.stringify({ data: { km: 6, rpe: { __delete__: true } } }) });
  assert.deepEqual(up.body.data, { date: "2026-11-20", km: 6 });
  assert.equal((await api("/api/db")).body.collections.sessions.s1.km, 6);
  assert.equal((await api("/api/db/bad name/x", { method: "PUT", body: JSON.stringify({ data: {} }) })).status, 400);
  await api("/api/db/sessions/s1", { method: "DELETE" });
  assert.equal((await api("/api/db")).body.collections.sessions.s1, undefined);
});

test("export and import round-trip, merge and replace", async () => {
  const { api } = plainApp;
  await api("/api/db/sessions/a", { method: "PUT", body: JSON.stringify({ data: { date: "2026-11-01", sport: "ride", kind: "endurance", durationS: 3600 } }) });
  await api("/api/db/config/profile", { method: "PUT", body: JSON.stringify({ data: { ftp: 250 } }) });
  const exp = await api("/api/export");
  assert.match(exp.headers.get("content-disposition"), /attachment; filename="trainingsched-training-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(exp.body.format, "trainingsched");
  const file = exp.body;
  file.collections.sessions.b = { date: "2026-11-02", sport: "run", kind: "easy", durationS: 1800 };
  const dry = await api("/api/import", { method: "POST", body: JSON.stringify({ file, dryRun: true }) });
  assert.equal(dry.body.counts.sessions, 2);
  assert.equal(Object.keys((await api("/api/db")).body.collections.sessions).length, 1, "dry run changes nothing");
  await api("/api/import", { method: "POST", body: JSON.stringify({ file, mode: "merge" }) });
  assert.equal(Object.keys((await api("/api/db")).body.collections.sessions).length, 2);
  await api("/api/import", { method: "POST", body: JSON.stringify({ file: { collections: { sessions: { c: { date: "2026-11-03" } } } }, mode: "replace" }) });
  const after = (await api("/api/db")).body.collections;
  assert.deepEqual(Object.keys(after.sessions), ["c"]);
  assert.equal(after.config, undefined, "replace removes everything else");
  assert.equal((await api("/api/import", { method: "POST", body: JSON.stringify({ file: { nope: 1 } }) })).status, 400);
});

test("old run-page exports become sessions", () => {
  const r = normalizeImport({ collections: {
    runs: { r1: { date: "2026-11-06", type: "long", km: 8, durationS: 3000, feel: 4, niggle: "", notes: "x" }, r2: { date: "2026-11-07", type: "variation", km: 5 } },
    config: { main: { easyHrCap: 150 } },
    coaching: { latest: { text: "t", createdAt: 1, runsCount: 2 } },
  } });
  assert.deepEqual(r.collections.sessions.r1, { sport: "run", kind: "long", where: null, date: "2026-11-06", km: 8, durationS: 3000, feel: 4, niggle: "", notes: "x" });
  assert.equal(r.collections.sessions.r2.kind, "workout");
  assert.equal(r.collections.config, undefined);
  assert.equal(r.collections.coaching.latest.count, 2);
});

test("anthropic: key stays on the server, tool loop round-trips", async () => {
  mock.requests.length = 0;
  const tools = [{ name: "propose_plan_change", description: "d", inputSchema: { type: "object" } }];
  const first = (await anthropicApp.api("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "move my long ride" }], tools }) })).body;
  assert.equal(first.toolCalls[0].name, "propose_plan_change");
  assert.equal(first.raw.provider, "anthropic");
  const second = (await anthropicApp.api("/api/llm", { method: "POST", body: JSON.stringify({ messages: [
    { role: "user", content: "move my long ride" },
    { role: "assistant", content: first.text, toolCalls: first.toolCalls, raw: first.raw },
    { role: "tool", toolCallId: first.toolCalls[0].id, name: "propose_plan_change", content: "Shown." },
  ], tools }) })).body;
  assert.equal(second.text, "Card is ready.");
  const sent = mock.requests.at(-1);
  assert.equal(sent.headers["x-api-key"], "k-a");
  assert.equal(sent.body.model, "m-a");
  assert.equal(sent.body.messages[2].content[0].type, "tool_result");
  assert.equal(sent.body.tools[0].input_schema.type, "object");
});

test("openai-compatible (deepseek preset): tool loop keeps reasoning, uses bearer key", async () => {
  mock.requests.length = 0;
  const tools = [{ name: "propose_numbers", description: "d", inputSchema: { type: "object" } }];
  const first = (await openaiApp.api("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "new ftp 290" }], tools }) })).body;
  assert.equal(first.toolCalls[0].name, "propose_numbers");
  await openaiApp.api("/api/llm", { method: "POST", body: JSON.stringify({ messages: [
    { role: "user", content: "new ftp 290" },
    { role: "assistant", content: "", toolCalls: first.toolCalls, raw: first.raw },
    { role: "tool", toolCallId: "call_1", name: "propose_numbers", content: "Shown." },
  ], tools }) });
  const sent = mock.requests.at(-1);
  assert.equal(sent.headers.authorization, "Bearer k-o");
  assert.equal(sent.body.messages[1].reasoning_content, "thinking");
  assert.equal(sent.body.messages[2].role, "tool");
  assert.equal(sent.body.max_tokens, 2000);
});

test("provider config validation", () => {
  assert.equal(llmConfig({ LLM_PROVIDER: "ollama", LLM_MODEL: "qwen3" }).enabled, true, "ollama needs no key");
  assert.equal(llmConfig({ LLM_PROVIDER: "ollama", LLM_MODEL: "qwen3" }).base, "http://localhost:11434/v1");
  assert.equal(llmConfig({ LLM_PROVIDER: "mistral", LLM_MODEL: "x" }).enabled, false, "mistral needs a key");
  assert.equal(llmConfig({ LLM_PROVIDER: "openai", LLM_MODEL: "x", LLM_API_KEY: "k" }).maxTokensField, "max_completion_tokens");
  assert.equal(llmConfig({ LLM_PROVIDER: "nope" }).enabled, false);
  assert.equal(llmConfig({ LLM_PROVIDER: "openai_compatible", LLM_MODEL: "x", LLM_API_KEY: "k" }).enabled, false, "needs a base URL");
});

test("seed.json in the data folder is imported once on first start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-seed-"));
  fs.writeFileSync(path.join(dir, "seed.json"), JSON.stringify({ collections: { runs: { r: { date: "2026-11-06", type: "easy" } } } }));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(ROOT, "server/server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, LLM_PROVIDER: "" }, stdio: "pipe" });
  try {
    let body;
    for (let i = 0; i < 50; i++) { try { body = await (await fetch(`http://127.0.0.1:${port}/api/db`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.equal(body.collections.sessions.r.kind, "easy");
    assert.ok(fs.existsSync(path.join(dir, "seed.json.imported")));
  } finally { child.kill(); }
});

test("settings from the page: name, coach, key masked and never exported, models, connection test", async () => {
  const app = await startApp({ LLM_PROVIDER: "" });
  try {
    const { api } = app;
    let v = (await api("/api/settings")).body;
    assert.equal(v.firstRun, true);
    assert.equal(v.llm.enabled, false);
    assert.ok(v.providers.some((p) => p.id === "ollama" && !p.needsKey));
    assert.equal((await api("/api/settings", { method: "PUT", body: JSON.stringify({ pronoun: "they" }) })).status, 400);

    v = (await api("/api/settings", { method: "PUT", body: JSON.stringify({ name: "Robin", pronoun: "she" }) })).body;
    assert.equal(v.firstRun, false);
    assert.equal(v.client.title, "Robin's Training Week");
    assert.match(await (await fetch(app.base + "/")).text(), /<title>Robin(&#39;|')s Training Week<\/title>/);

    // Model list for a draft, before anything is saved; the bad key is reported as such.
    const models = await api("/api/settings/models", { method: "POST", body: JSON.stringify({ llm: { provider: "openai_compatible", baseUrl: `${mock.url}/v1`, key: "k-1" } }) });
    assert.deepEqual(models.body.models, ["model-a", "model-b"]);
    assert.equal((await api("/api/settings/models", { method: "POST", body: JSON.stringify({ llm: { provider: "anthropic", baseUrl: `${mock.url}/v1`, key: "bad" } }) })).body.code, "auth_failed");

    v = (await api("/api/settings", { method: "PUT", body: JSON.stringify({ llm: { provider: "anthropic", baseUrl: `${mock.url}/v1`, key: "sk-secret-1234", model: "model-a", tools: true } }) })).body;
    assert.equal(v.llm.enabled, true);
    assert.equal(v.llm.key.hint, "…1234");
    assert.equal(v.client.llm.enabled, true);
    const raw = JSON.stringify(v) + JSON.stringify((await api("/api/settings")).body) + JSON.stringify((await api("/api/export")).body) + await (await fetch(app.base + "/")).text();
    assert.doesNotMatch(raw, /sk-secret/, "the key never leaves the server");

    const t = (await api("/api/settings/test", { method: "POST", body: "{}" })).body;
    assert.equal(t.ok, true);
    assert.equal(t.tools, "works");
    assert.equal(mock.requests.at(-1).headers["x-api-key"], "sk-secret-1234");

    // Saving again without a key keeps it; moving to another address drops it until it is entered again.
    v = (await api("/api/settings", { method: "PUT", body: JSON.stringify({ llm: { provider: "anthropic", baseUrl: `${mock.url}/v1`, model: "model-b" } }) })).body;
    assert.equal(v.llm.enabled, true);
    v = (await api("/api/settings", { method: "PUT", body: JSON.stringify({ llm: { provider: "anthropic", baseUrl: "http://127.0.0.1:9/v1", model: "model-b" } }) })).body;
    assert.equal(v.llm.enabled, false);
    assert.equal(v.llm.key.stale, true);

    v = (await api("/api/settings", { method: "PUT", body: JSON.stringify({ llm: { provider: "" } }) })).body;
    assert.equal(v.llm.enabled, false);
    assert.equal((await api("/api/settings/test", { method: "POST", body: "{}" })).body.code, "not_configured");
    const file = fs.readFileSync(path.join(app.dir, "settings.json"), "utf8");
    assert.equal((fs.statSync(path.join(app.dir, "settings.json")).mode & 0o777).toString(8), "600");
    assert.ok(!(await api("/api/db")).body.collections.settings, "settings are not part of the training data");
    assert.ok(file.includes("Robin"));
  } finally { app.stop(); }
});

test("environment settings still work and are shown without the key", async () => {
  const app = await startApp({ ATHLETE_NAME: "Kim", LLM_PROVIDER: "mistral", LLM_MODEL: "m", LLM_API_KEY: "env-key-9876", LLM_BASE_URL: `${mock.url}/v1` });
  try {
    const v = (await app.api("/api/settings")).body;
    assert.equal(v.firstRun, false);
    assert.equal(v.llm.provider, "mistral");
    assert.equal(v.llm.source, "env");
    assert.equal(v.llm.key.hint, "…9876");
    assert.doesNotMatch(JSON.stringify(v), /env-key/);
    const t = (await app.api("/api/settings/test", { method: "POST", body: "{}" })).body;
    assert.equal(t.tools, "works");
    // Saving the coach in the page keeps using the environment key for the same provider and address.
    const s = (await app.api("/api/settings", { method: "PUT", body: JSON.stringify({ llm: { provider: "mistral", baseUrl: `${mock.url}/v1`, model: "m2" } }) })).body;
    assert.equal(s.llm.enabled, true);
    assert.equal(s.llm.key.source, "env");
  } finally { app.stop(); }
});
