[![FLE Link: run an agent next to your model](media/banner-flelink.jpg)](https://flelink.run)

<div align="center">

# FLE Durable

**An always-on local agent that works from events.**

Events in, one durable queue, one agent. It survives restarts without losing or repeating anything,
plans its own follow-ups, and asks before anything it cannot undo.

[Quick start](#quick-start) ·
[How it works](#how-it-works) ·
[Events](#where-events-come-from) ·
[API](#api) ·
[FLE Link](https://flelink.run) ·
[FLE engine](https://github.com/sirfyyn/FastLocalExperts)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node 22.19+](https://img.shields.io/badge/node-22.19%2B-brightgreen.svg)](package.json)

</div>

## What it is

Most local agents wait for you to type. FLE Durable runs all the time next to your local model and acts when
something happens: an item on its agenda is due, a tool sends a webhook, you write to it. Every event lands in a
queue inside one SQLite file before the agent sees it, so a crash or a reboot neither loses an event nor runs one
twice. When a task needs a later look, the agent puts it on its own agenda ("check in 20 minutes whether the
download finished") instead of keeping a turn open.

It is built on [pi-durable](https://github.com/earendil-works/pi) (Earendil Works): durable conversations, tasks
and documents with checkpoints. FLE Durable adds the event side: the queue, the agenda, webhooks, approvals, and
ports for event sources of your own.

```text
 agenda (you + the agent) ─┐
 webhooks from your tools ─┼──► durable queue ──► agent (pi-durable) ──► tools: files, shell, web
 your chat ────────────────┤     (SQLite)          │  local model via /v1
 your own sources ─────────┘                       └─► approvals for destructive steps
```

## Part of FLE

| | |
|---|---|
| [**FLE**](https://github.com/sirfyyn/FastLocalExperts) | the engine: a llama.cpp fork that runs large Mixture-of-Experts models on one GPU |
| [**FLE Link**](https://flelink.run) | the layer above: installs the engine, picks a model that fits, serves `/v1`, Studio and desktop app |
| **FLE Durable** | the agent above that: always on, works from events, uses whatever model FLE Link serves |

The easiest way to run FLE Durable is the **Agent** page in FLE Link: it starts FLE Durable with the model of the
Engine page, shows the agenda by day, what waits and what asks you, and gives your tools a webhook key.

## Quick start

### With FLE Link

1. Install [FLE Link](https://flelink.run) and start a model on the Engine page.
2. Get FLE Durable and its packages once:

   ```bash
   git clone https://github.com/sirfyyn/fle-durable && cd fle-durable && npm ci --ignore-scripts
   ```

3. In FLE Link: **Agent → Set up**, enter the folder, **Start**. Tick "Start with FLE Link" to keep it on.

### On its own

Any OpenAI-compatible server works: `llama-server`, FLE, FLE Link, vLLM, Ollama's `/v1`.

```bash
git clone https://github.com/sirfyyn/fle-durable && cd fle-durable && npm ci --ignore-scripts
export FLE_DURABLE_TOKEN=$(openssl rand -hex 32)
export FLE_DURABLE_MODEL_URL=http://127.0.0.1:8080/v1   # your model server
export FLE_DURABLE_CONTEXT=32768                        # its context window
node src/main.js
```

It listens on `http://127.0.0.1:8740`. Talk to it over the [API](#api), or open its page with a one-time code:

```bash
curl -s -X POST -H "Authorization: Bearer $FLE_DURABLE_TOKEN" http://127.0.0.1:8740/api/session/code
# then open http://127.0.0.1:8740/?code=<code>
```

## How it works

- **One durable queue.** An event is first stored (one commit), then handed to the agent as a turn with the event's
  id as request id. A crash in between hands the same event over again, and pi-durable makes the second hand-over a
  no-op. The same id sent twice later is recognised too.
- **The owner first.** Your own messages have right of way and may steer a running turn; background events wait for it.
- **Events are data.** Only your messages are instructions. Webhooks, web pages, files and command output reach the
  agent marked as data.
- **Approvals only where it matters.** Deleting your home folder, `git reset --hard`, formatting a disk and the like are
  stopped until you approve exactly that command (`request_approval`). Everything else the agent simply does.
- **Survives restarts.** Conversations, the queue, the agenda and approvals live in one SQLite file. Open turns resume
  from their last checkpoint.

## Where events come from

| Source | What |
|---|---|
| **Chat** | you write to it (`POST /api/message`, its page, FLE Link) |
| **Agenda** | items you plan (once, daily, on certain days, every N minutes) and items the agent plans for itself with `agenda_plan`; it can cancel only its own |
| **Webhook** | `POST /api/events` from any tool: CI, home automation, mail filters, cron |
| **Your own** | a module with `create(ctx)` returning `{ start, stop }`, enabled in the config |

A source of your own, for example every text file dropped into a folder becomes an event
([examples/folder-source.js](examples/folder-source.js)):

```json
{ "ports": { "sources": ["builtin", { "use": "./examples/folder-source.js", "folder": "~/inbox" }] } }
```

```bash
node src/main.js check-source ./examples/folder-source.js   # checks it against the contract
```

Every port is filled by `builtin`, `off`, a registered name or your module; all of them pass the same contract check.

## API

Every call needs `Authorization: Bearer <token>` (or the page's cookie after a one-time code).

| Route | What |
|---|---|
| `GET /api/health` | model, storage, queue, sources |
| `POST /api/message` `{text, id?}` | you write (right of way) |
| `GET /api/conversation` · `GET /api/stream` | the conversation, and its events as server-sent events |
| `POST /api/abort` | stop the running turn |
| `GET` · `POST /api/agenda` · `DELETE /api/agenda/<id>` · `POST /api/agenda/<id>/pause` | the agenda |
| `POST /api/events` `{text, id?, from?, ref?}` | webhook into the queue |
| `GET /api/queue` · `POST /api/queue/pause` | what waits; pause and resume |
| `GET /api/approvals` · `POST /api/approvals/<id>` `{decision: granted\|refused, note?}` | approvals |
| `POST /api/session/code` | a one-time sign-in code for the page |

```bash
curl -X POST http://127.0.0.1:8740/api/events -H "Authorization: Bearer $FLE_DURABLE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"id":"ci-42","from":"ci","text":"Build 42 failed on main"}'
```

## Configuration

The environment, optionally a JSON file (`FLE_DURABLE_CONFIG` or `--config`):

| Variable | Default | |
|---|---|---|
| `FLE_DURABLE_TOKEN` | – | API token, at least 32 characters (required) |
| `FLE_DURABLE_MODEL_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible server |
| `FLE_DURABLE_MODEL` | `local` | model id |
| `FLE_DURABLE_CONTEXT` | `32768` | context window; compaction follows it |
| `FLE_DURABLE_HOME` | `~/.fle-durable` | SQLite file and work folder |
| `FLE_DURABLE_WORKSPACE` | `<home>/work` | the agent's working folder |
| `FLE_DURABLE_HOST` / `FLE_DURABLE_PORT` | `127.0.0.1` / `8740` | loopback only unless `"allowNetwork": true` |

The JSON file can also set `agent` (its name), `instructions` (added to its prompt), `agenda.zone`, `ports.sources`.

## As a library

```js
import { loadConfig, startAgent } from 'fle-durable';
const agent = await startAgent(loadConfig());
await agent.enqueue({ id: 'build-42', text: 'Build 42 failed', source: 'ci' });
```

## Development

```bash
npm test                         # agenda, ports, guard, queue, the whole way with a fake model
python3 tools/sauber.py .        # no private addresses, e-mails or secrets in the files
```

Only `src/pi.js` imports the Earendil packages (a test checks it), so they can be swapped, vendored or forked there.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). pi-durable, pi-ai and chord are MIT, by Earendil Works.
