// A fake model provider that speaks both the Anthropic Messages API and the OpenAI Chat Completions API.
// When tools are offered and no tool result has come back yet, it calls the first tool; otherwise it answers in text.
import http from "node:http";

export function startMockLlm({ port = 0, toolInput } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      requests.push({ path: req.url, headers: req.headers, body: json });
      const reply = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const text = (msgs) => JSON.stringify(msgs);
      const makeInput = (tool, all) => (typeof toolInput === "function" ? toolInput(tool, all) : toolInput || {});
      if (req.url.endsWith("/messages")) {
        const last = json.messages.at(-1);
        const hasResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
        if (json.tools?.length && !hasResult) {
          return reply({ content: [{ type: "text", text: "Proposing a change." }, { type: "tool_use", id: "toolu_1", name: json.tools[0].name, input: makeInput(json.tools[0], text(json.messages)) }], stop_reason: "tool_use" });
        }
        return reply({ content: [{ type: "text", text: hasResult ? "Card is ready." : "**How it's going**\nSteady." }], stop_reason: "end_turn" });
      }
      if (req.url.endsWith("/chat/completions")) {
        const hasResult = json.messages.some((m) => m.role === "tool");
        if (json.tools?.length && !hasResult) {
          const t = json.tools[0].function;
          return reply({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, reasoning_content: "thinking", tool_calls: [{ id: "call_1", type: "function", function: { name: t.name, arguments: JSON.stringify(makeInput({ name: t.name }, text(json.messages))) } }] } }] });
        }
        return reply({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: hasResult ? "Card is ready." : "**How it's going**\nSteady." } }] });
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}
