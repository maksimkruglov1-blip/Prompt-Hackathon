# Bahn Control Room — Prompt Operations Hackathon

Attention-queue **Control Room** plus one real **on-the-road** agent, built on Bahn’s official [car-delivery-control-room](https://github.com/Bahn-Express/car-delivery-control-room) packet.

Synthetic data only. The agent never contacts the paying customer. Bookings, costs, promise changes and customer messages require human approval.

**Product UI: English.**

## What you get

1. **Control Room** (`/`) — left: only orders that need a person; right: problem, current location, facts with sources, options with **Price / Time**, **Book** links, Approve / Change.
2. **On-the-road agent** — LLM-in-a-loop with tools (`ask_driver`, `lookup_order`, `gather_facts`, `estimate_recovery`, `search_trips`). Mock path by default; optional OpenRouter / OpenAI key for a live model.
3. Demo seeds: ferry sold-out `CD-420299` (BMW M4) and roadside Bentley `CD-420322`.
4. Lane board kept at `/lanes` for reference (not the primary UX).

## Requirements

- Node.js **24+**
- Docker (Compose)

## Clone → run (hand-in path)

```sh
# from the repo root
cd starter
cp .env.example .env
npm ci
docker compose up -d --wait
npm run db:push
npm run db:seed
npm run attachments:seed
npm run dev -- -p 43123 -H 127.0.0.1
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123) — you should see the **Control Room**, not the lane board.

### Ports

| Service | Port | Notes |
|---------|------|--------|
| Next.js app | **43123** | Use this port in demos (starter default is 3000) |
| Postgres | 5438 | From `compose.yaml` / `DATABASE_URL` |
| Attachments S3 API | 9009 | Local RustFS |
| Attachments console | 9010 | Optional |

If ports collide, change them in `starter/compose.yaml` and matching lines in `starter/.env`.

### Optional OpenRouter / OpenAI

Without a key the **mock** agent runs (fine for the demo). For a live model, put this in `starter/.env` only — **never commit secrets**:

```sh
OPENAI_API_KEY=          # OpenRouter or OpenAI key
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4o-mini
# Optional:
# OPENROUTER_HTTP_REFERER=http://127.0.0.1:43123
# OPENROUTER_X_TITLE=Bahn Control Room
# TAVILY_API_KEY=          # optional snippets inside search_trips only
```

Restart the dev server after editing `.env`. The control-room header shows **agent LLM** vs **agent mock**.

`search_trips` Book URLs (Tallink, Viking Line, Finnlines, Eckerö, ADAC roadside-assistance info) work **without** any paid search key.

## Demo path (~2 minutes)

1. Open Control Room — ferry case `CD-420299` is selected by default; Bentley `CD-420322` is in the queue.
2. Read **Problem**, **Current location**, and **Facts** (each fact shows its source).
3. Compare options by **Price** / **Time**, open **Book** (you book; agent never does), then **Approve**.
4. Follow **Next for ops**: Book → fill contacts → person updates the dealer / customer.
5. Optional: Bentley `CD-420322` for roadside tow (ADAC roadside-assistance Book link).

Pitch: Bahn has no on-the-road agent yet — this is that layer.

## GitHub hand-in

This cloud branch tracks Origin. **You** push to your public GitHub fork ([Prompt-Hackathon](https://github.com/maksimkruglov1-blip/Prompt-Hackathon) or your team repo) with your own credentials / PAT. Do not commit `.env` or API keys.

## Packet layout

- `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md` — challenge brief
- `dataset/`, `attachments/` — fictional orders and files
- `starter/` — Next.js app (this solution)

## How we built this with AI

Short hand-in note (edit freely):

**What we asked agents for.** Attention-queue Control Room + one on-the-road agent (ferry + roadside), English UI, approvals before booking, never contact the paying customer, synthetic data, `search_trips` with real Book URLs, facts with sources, current location under Problem.

**What we checked.** CD-420299 and CD-420322 open → Book → Approve; Change with a note re-runs the agent; queue urgency with many items; narrow viewport; mock path without API keys; README clone path from repo root into `starter/`.

**What we threw away.** Lane board as the primary UX; Finnish product UI; auto-booking; raw SQL/API errors in the UI; a sticky approve footer that blocked Book clicks; applying a `git apply` patch path that failed on Windows (switched to overlay zip).

**Where we did not take the first answer.** Price and Time first on options (then kept on one line); problem line restored above the compare; current-location row under Problem; fact sources made visible; recommended option primary with one alternative (not a flat multi-card wall).

## Notes

- `npm run db:seed` replaces challenge snapshot data; participant table `agent_runs` has no FK into seed tables so reseeding stays safe.
- Judge-gap UI refresh (recommended option, queue urgency, Change re-run, shortened time labels) lives in `agent_runs` + app code — **no DB re-seed required** for an existing local DB; re-run the agent or reload Control Room so demo seeds refresh. Fresh clones still need `db:push` / `db:seed` / `attachments:seed` as above.
- All names and messages are fictional.
