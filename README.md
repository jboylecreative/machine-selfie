# Machine Selfie

An AI (Gemini) painting its own self-portraits, live. Nobody gives it a prompt. It gets a canvas and a real
toolset — natural-media brushes, vector paths, layers, blend modes, adjustment layers,
filters and type — and decides for itself what to make and when it's finished. Viewers watch
every mark being drawn live, alongside the artist's thinking and sketchbook notes.

## Run it

```bash
npm install
npm run fonts            # one-time: downloads the studio typefaces into public/fonts
# put your key in .env:  GEMINI_API_KEY=...
npm run dev              # studio server + viewer → http://localhost:5173
```

The server starts **idle**. Press **Begin** on the site: the artist makes `WORKS_PER_RUN` (10)
works, resting `REST_SECONDS` (20) between them, then the studio idles and the button returns as
**Continue** for another run. The run only lasts while the browser tab that pressed the button
stays open: close it and, after a 10-second grace period (so a reload doesn't count), the studio
stops mid-work and returns to idle. Other viewers can watch but don't keep it running.

- `npm run server -- --list-models` lists the Gemini models your key can use (set `GEMINI_MODEL` in `.env`).
- `npm run server -- --once` makes a single work per run (overrides `WORKS_PER_RUN`).
- In `npm run dev`, editing any `.ts` file restarts the server and cuts off the current work; it is
  rebuilt from its replay log on the next start and shown in the gallery as unfinished.
  Editing `prompts/*.md` is safe — it takes effect at the next work.
- `npx tsx scripts/demo-session.ts` writes a scripted (non-AI) session to the gallery, for testing the viewer without API calls.
- `npx tsx scripts/engine-smoke.ts` renders a sampler of every brush and tool to `data/engine-smoke.png`.

## How it works

```
Gemini ──tool calls──▶ server: tools.ts validates → engine ops → StudioDocument (Skia)
   ▲                        │                                   │
   └── canvas image ◀───────┘                                   └── ops + thoughts ──WebSocket──▶ browsers
                                                                       (same engine replays each op
                                                                        progressively: the line is drawn)
```

- **`src/engine/`** — the shared studio engine (runs on the server *and* in every viewer's browser):
  layers & compositing, brushes, vector paths, filters, adjustments. Every action is a small
  deterministic *op*; viewers re-render ops themselves, animating strokes along their path, so
  broadcasting costs almost nothing and every session can be replayed exactly.
- **`src/server/agent.ts`** — the agent loop. Each turn Gemini thinks (thought summaries are
  streamed live), calls tools, then is shown the resulting canvas. Older canvas images are
  dropped from context; its `sketchbook` notes persist.
- **`src/server/tools.ts`** — the toolset Gemini sees, in Photoshop vocabulary it already knows.
- **`src/client/`** — the viewer site: live studio, gallery, replays.
- **`data/sessions/<id>/`** — the archive: `events.jsonl` (full replay), `meta.json`, `final.png`, `thumb.jpg`.

## Shaping the artist

- **`prompts/system.md`** — the artist's system prompt: its situation, its freedom, how to work.
  Re-read at the start of every session, so you can edit between works.
- **`prompts/studio-manual.md`** — the technical manual for the tools.
- By default every work starts completely fresh: the artist is told nothing about other works,
  not even that they exist. Set `REMEMBER_PAST_WORKS=true` to show it the titles/statements of
  its earlier works (and thumbnails of the last three) so it develops a body of work instead.
- `TEMPERATURE`, `THINKING_LEVEL`, `MAX_TURNS`, `MAX_TOOL_CALLS`, `REST_SECONDS` in `.env`.

## Password

Set `SITE_PASSWORD` to put the whole site behind a simple login screen (watching, gallery and
the Begin button all need it; a cookie remembers visitors for 30 days). Leave it empty locally
for no login. It keeps casual visitors out — it is not real account security.

## Deploying (Railway)

`railway.json` sets the build (`npm run build`), start (`npm start`), a health check and
restart-on-crash. The server is a single always-on Node process; Railway keeps it running.

1. Push this repo to GitHub (`.env` and `data/` are git-ignored, so your key and local works stay local).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. **Variables** tab: add `GEMINI_API_KEY` and `SITE_PASSWORD` (plus any settings from `.env.example`
   you want to change). Don't set `PORT` — Railway provides it.
4. Attach a **volume** to the service (right-click the service → *Attach volume*, mount path `/data`).
   The archive uses it automatically; without one, the gallery is wiped on every deploy.
5. **Settings → Networking → Generate Domain** for a public `https://….up.railway.app` URL.

Each deploy restarts the server (with a volume attached there's a few seconds of downtime),
cutting off any work in progress — it's recovered into the gallery as unfinished.

Cost scales with session length: every turn sends the conversation plus a canvas image to the
model. `MAX_TURNS` and `MAX_TOOL_CALLS` cap each work.
