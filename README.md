# trainingsched

A self-hosted training planner and log with a tough-but-fair AI coach. One small Node server per athlete, no database server, no dependencies beyond Node.

- **Week**: this week's sessions by day with targets, one-tap logging, GPX/TCX import (power, heart rate, cadence, climbing), and checks for slacking and overdoing it.
- **Coach**: short coaching notes, feedback on every new session, and a chat that can propose changes to your plan or numbers, which you apply or discard.
- **Progress**: 20-minute power benchmark, intensity mix, training load per sport, and the full log.
- **Plan**: 4-week progression cycles (3 build weeks and 1 recovery week with a test), your weekly structure, numbers and zones, goals, background, and **export/import of your whole history**.

The coach works with Anthropic, OpenAI, Mistral, DeepSeek, Gemini, OpenRouter, any other OpenAI-compatible API, or a local Ollama. Without a provider, everything except the coach still works.

## Run it

```sh
cp .env.example .env      # set the athlete names and, optionally, the coach provider
docker compose up -d --build
```

`docker-compose.yml` runs two instances (`trainingsched-1` and `trainingsched-2`), each with its own data volume. Remove one if you only need one.

### Behind Pangolin

The app has **no login of its own**: anyone who can reach it can read and change the data. Only expose it through an authenticating proxy.

1. Put the containers on the network your Newt container uses. `docker-compose.yml` expects an external network called `pangolin`; change the name if yours differs. No ports are published by default.
2. In Pangolin, add one HTTP resource per athlete, for example `training.example.com` → `trainingsched-1:8080`.
3. Turn on authentication for each resource: Pangolin user login, or a PIN or password on the resource for someone without an account.

Live updates use Server-Sent Events on `/api/events`, which pass through Pangolin/Traefik without extra configuration.

### Without Docker

```sh
ATHLETE_NAME=Sam DATA_DIR=./data PORT=8080 npm start
```

Node 20 or newer.

## The coach

Set these in `.env`:

| Variable | What it does |
|---|---|
| `LLM_PROVIDER` | `anthropic`, `openai`, `mistral`, `deepseek`, `gemini`, `openrouter`, `ollama` or `openai_compatible`. Empty turns the coach off. |
| `LLM_MODEL` | The model name as your provider writes it. |
| `LLM_API_KEY` | Your API key. Not needed for Ollama. It stays on the server and never reaches the browser. |
| `LLM_BASE_URL` | Optional for most providers; required for `openai_compatible`. For Ollama on another machine, e.g. `http://192.168.1.50:11434/v1`. |
| `LLM_MODEL_QUICK` | Optional cheaper model for small jobs (compacting the chat). |
| `LLM_TOOLS` | `true` by default. Plan and number proposals need tool calling; set `false` for local models without it, and the chat gives advice only. |
| `LLM_MAX_TOKENS`, `LLM_TIMEOUT_MS` | Output limit per answer (default 2000) and how long to wait for the provider (default 180 s; raise it for slow local models). |

API use is billed by your provider per token and is separate from any chat subscription (a Claude Pro plan, for example, does not include API access).

Each instance also reads `ATHLETE_NAME` (shown in the title and used by the coach) and `ATHLETE_PRONOUN` (`he` or `she`). In `docker-compose.yml` these come from `ATHLETE_1_*` and `ATHLETE_2_*` in `.env`.

## Your data

Each instance keeps everything in one file, `/data/store.json`, inside its Docker volume. Back up the volume, or use the page:

- **Plan → Your data → Export everything** downloads the whole history as one JSON file.
- **Import a file** previews what a file contains, then either **adds** it to the current data (entries with the same ID are overwritten) or **replaces** everything.

Import understands exports from this app and from the earlier claude.ai training pages; runs from the run-only coaching page become run sessions.

To load a history before first use, copy it into the empty volume as `seed.json` and restart. It is imported once and renamed to `seed.json.imported`:

```sh
docker cp my-export.json trainingsched-1:/data/seed.json && docker restart trainingsched-1
```

Training data, exports and `.env` are in `.gitignore`; keep them out of this repository.

## Develop

```sh
npm test    # server, storage, import/export and both LLM API formats against a fake provider
```

- `app/index.html`: the whole page (HTML, CSS and JS in one file). `%%TITLE%%` is filled in by the server.
- `public/shim.js`: the small runtime the page uses (`window.claude.use("db" | "user" | "sample")`): documents, live updates and the coach, all through this server.
- `server/`: `server.js` (HTTP API), `store.js` (JSON file store), `llm.js` (provider adapters), `importer.js` (import formats).
