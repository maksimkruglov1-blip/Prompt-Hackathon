# Bahn Control Room — Prompt Operations Hackathon

Attention-queue control room plus one real **on-the-road** agent, built on Bahn’s official [car-delivery-control-room](https://github.com/Bahn-Express/car-delivery-control-room) packet.

Synthetic data only. The agent never contacts the paying customer. Bookings, costs, promise changes and customer messages require human approval.

## What you get

1. **Control Room** (`/`) — left: only orders that need a person; right: problem headline, two options with price/time, Approve / Change.
2. **On-the-road agent** — LLM-in-a-loop with tools (`ask_driver`, `lookup_order`, `gather_facts`, `estimate_recovery`). Ships with a **mock LLM path**; set `OPENAI_API_KEY` for a real model.
3. Demo seed: Bentley Continental GT roadside stop (`CD-420322` / `ord-00322`) opens with a ready decision card.
4. Lane board kept at `/lanes` for reference (not the primary UX).

## Requirements

- Node.js **24+**
- Docker (Compose)

## Run from a fresh clone

```sh
cd starter
cp .env.example .env
npm ci
docker compose up -d --wait
npm run db:push
npm run db:seed
npm run attachments:seed
npm run dev -- -p 43123 -H 127.0.0.1
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

### Ports used here

| Service | Port | Notes |
|---------|------|--------|
| Next.js app | **43123** | Uncommon port for this cloud VM (starter default is 3000) |
| Postgres | 5438 | From `compose.yaml` / `DATABASE_URL` |
| Attachments S3 API | 9009 | Local RustFS |
| Attachments console | 9010 | Optional browser console |

If 5438 / 9009 / 9010 collide, change them in `starter/compose.yaml` and matching lines in `starter/.env`.

### Real LLM / OpenRouter (optional)

The on-the-road agent uses an OpenAI-compatible client (`OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENAI_MODEL`). Mock is the default when the key is unset. **Never commit real keys.**

```sh
# in starter/.env  (copy from .env.example)
OPENAI_API_KEY=          # OpenRouter or OpenAI key — never commit
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4o-mini
# Optional OpenRouter attribution headers (defaults applied when BASE_URL is openrouter.ai):
# OPENROUTER_HTTP_REFERER=http://127.0.0.1:43123
# OPENROUTER_X_TITLE=Bahn Control Room
```

#### How to test with OpenRouter

1. Put the vars above in `starter/.env` (local only).
2. Restart the Next.js dev server so it reloads env.
3. Open the control room — the header shows **agent LLM** when a key is present, otherwise **agent mock**.
4. Open a case (e.g. `CD-420299`) → **Re-run agent**. After it finishes, the decision card’s agent mode is `llm` (also stored on the run). If the live call fails, the app falls back to mock and logs the error.

## Demo path (about 2 minutes)

1. Open the control room — ferry case `CD-420299` (BMW M4, sold-out overnight) is selected by default; Bentley `CD-420322` is also seeded.
2. Compare **three ferry lines** (NordSea Link, Baltic Gate Ferries, Silja Route Express) by **Price** / **Time**, with a short price breakdown under each total, then **Approve**.
3. Fill **Ops completes contacts** (passenger name, phones, hotel confirmation — agent left these blank). Save booking contacts (still mock; no purchase).
4. Optional: Bentley `CD-420322` for roadside tow (also shows price breakdown). Pitch: Bahn has no on-the-road agent yet — this is that layer.

## Packet layout

- `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md` — challenge brief
- `dataset/`, `attachments/` — fictional orders and files
- `starter/` — Next.js app (this solution lives here)

## Notes

- `npm run db:seed` replaces challenge snapshot data; participant table `agent_runs` has no FK into seed tables so reseeding stays safe.
- All names and messages are fictional.
