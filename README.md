# trainingsched

A self-hosted training planner and log with a tough-but-fair AI coach. One small Node server per athlete, no database server, no dependencies beyond Node.

- **Week**: this week's sessions by day with targets, one-tap logging, GPX/TCX import (power, heart rate, cadence, climbing), and checks for slacking and overdoing it.
- **Coach**: short coaching notes, feedback on every new session, and a chat that can propose changes to your plan or numbers, which you apply or discard.
- **Progress**: 20-minute power benchmark, intensity mix, training load per sport, and the full log.
- **Plan**: 4-week progression cycles (3 build weeks and 1 recovery week with a test), your weekly structure, numbers and zones, goals and background.
- **Settings**: your name, the coach (provider, key, model, with a connection test), and **export/import of your whole history**.

The coach works with Anthropic, OpenAI, Mistral, DeepSeek, Gemini, OpenRouter, any other OpenAI-compatible API, or a local Ollama. Without a provider, everything except the coach still works.

## Run it

Paste [`docker-compose.yml`](docker-compose.yml) into Dockge as a new stack and deploy it, or:

```sh
curl -O https://raw.githubusercontent.com/KJori/trainingsched/main/docker-compose.yml
docker compose up -d
```

That's all you need on the server. The compose file pulls the ready-made image `ghcr.io/kjori/trainingsched:latest`, so nothing is built and no `.env` is needed. It runs two pages (`trainingsched-1` and `trainingsched-2`), each with its own data volume; remove one if you only need one.

Open a page and it starts on **Settings** with four steps: your name, your history (import a file), the coach (optional), and your usual week.

### Behind Pangolin

The app has **no login of its own**: anyone who can reach it can read and change the data. Only expose it through an authenticating proxy.

1. The containers join the Docker network called `pangolin`, which your Newt container should be on. If yours has another name, change it at the bottom of the compose file. No ports are opened.
2. In Pangolin, add one HTTP resource per page, for example `training.example.com` → `trainingsched-1:8080`.
3. Turn on authentication for each resource: Pangolin user login, or a PIN or password on the resource for someone without an account.

Live updates use Server-Sent Events on `/api/events`, which pass through Pangolin/Traefik without extra configuration.

Without Pangolin, uncomment the `ports:` lines to open the pages on your LAN, and keep them off the internet.

### Updating

In Dockge, press **Update** on the stack. Or `docker compose pull && docker compose up -d`. Your data and settings stay in the volumes.

## The coach

Set it up in the page, under **Settings → Coach**:

1. Pick a provider. The page says where to get a key.
2. Paste the key. It is stored on the server only, is never sent back to the browser and is never included in exports. It is only used for the address it was entered for: point the coach at another server and you have to enter the key again.
3. **Load models** asks the provider which models your key can use; pick one, or type a name.
4. **Save and test** sends one short test request and tells you what happened:

| Result | Meaning |
|---|---|
| Connected, tool calling works | Everything works, including proposals for your plan and numbers. |
| Connected, but it didn't use the test tool | Notes and answers work; proposals may not. Pick a larger model, or switch tool calling off under More options. |
| The provider refused the key | Wrong or incomplete key, or no API access or credit on the account. |
| The provider rejected the request | Usually a model name the provider doesn't know. |
| Couldn't get an answer | The address is wrong or the server is down; the details say which. |

API use is billed by your provider per request and is separate from chat subscriptions (a Claude Pro plan, for example, does not include API access).

**Ollama** needs no key. It has to accept connections from the network: start it with `OLLAMA_HOST=0.0.0.0`. For Ollama on the same server, the default address `http://host.docker.internal:11434/v1` works; for another computer, use its LAN address, e.g. `http://192.168.1.50:11434/v1`. Slow machine? Raise `LLM_TIMEOUT_MS` (see below).

### Configuring from the server instead

Everything in Settings can also come from environment variables: copy [`.env.example`](.env.example) to `.env` and add `env_file: .env` to each service. What you save in the page wins over the environment. Two limits are only set this way: `LLM_MAX_TOKENS` (output per answer, default 2000) and `LLM_TIMEOUT_MS` (how long to wait for the provider, default 180 s).

## Your data

Each page keeps its training data in `/data/store.json` and its settings (name, coach, key) in `/data/settings.json`, inside its Docker volume. Back up the volume, or use the page:

- **Settings → Your data → Export everything** downloads the whole training history as one JSON file. Settings and the key are not in it.
- **Import a file** previews what a file contains, then either **adds** it to the current data (entries with the same ID are overwritten) or **replaces** everything.

Import understands exports from this app and from the earlier claude.ai training pages; runs from the run-only coaching page become run sessions.

To load a history before first use, copy it into the empty volume as `seed.json` and restart. It is imported once and renamed to `seed.json.imported`:

```sh
docker cp my-export.json trainingsched-1:/data/seed.json && docker restart trainingsched-1
```

Training data, exports and `.env` are in `.gitignore`; keep them out of this repository.

## Build it yourself

```sh
docker build -t ghcr.io/kjori/trainingsched:latest .     # then docker compose up -d uses your build
ATHLETE_NAME=Sam DATA_DIR=./data PORT=8080 npm start     # or without Docker, Node 20 or newer
```

If you mount a host folder as `/data` instead of a named volume, give it to the container's user first: `chown -R 1000:1000 <folder>`.

Every push to `main` runs the tests, builds the image, starts it and checks it, then publishes it to GitHub's container registry ([workflow](.github/workflows/image.yml)).

## Develop

```sh
npm test    # server, storage, settings, import/export and both LLM API formats against a fake provider
```

- `app/index.html`: the whole page (HTML, CSS and JS in one file). `%%TITLE%%` is filled in by the server.
- `public/shim.js`: the small runtime the page uses (`window.claude.use("db" | "user" | "sample")`): documents, live updates and the coach, all through this server.
- `server/`: `server.js` (HTTP API), `store.js` (JSON file store), `settings.js` (settings made in the page), `llm.js` (provider adapters), `importer.js` (import formats).
