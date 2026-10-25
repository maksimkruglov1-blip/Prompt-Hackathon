# On the Road Control — Prompt Operations Hackathon

Attention-queue **Control Room** plus one real **on-the-road** agent, built on Bahn’s official [car-delivery-control-room](https://github.com/Bahn-Express/car-delivery-control-room) packet.

Synthetic data only. The agent never contacts the paying customer. Bookings, costs, promise changes and messages to a customer require a person’s approval. Asking questions and looking things up do not.

**Product UI: English.**

## What you get

1. **Control Room** (`/`) — left: only orders that need a person, ranked P1 → P2 → P3. Right: problem, delivery stage, dated timeline, facts with sources, driver chat, options with **Price / Time**, a prefilled **Booking draft**, **Copy & open**, Approve / Change.
2. **On-the-road agent** — a model in a tool loop (`lookup_order`, `gather_facts`, `ask_driver`, `estimate_recovery`, `search_trips`). Every queued case is processed in the background and stored, so opening a card shows the decision. Mock path by default; optional OpenRouter / OpenAI key for a live model.
3. Demo seeds: ferry sold-out `CD-420299` (BMW M4, Leipzig → Helsinki) and roadside Bentley `CD-420322` (Munich → Hamburg).
4. Lane board kept at `/lanes` for reference. It is not the primary UX.

## Requirements

- Node.js **24+**
- Docker (Compose)

## Clone → run (hand-in path)

From a fresh clone of this repository:

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

Leave that terminal open. When it says Ready, open [http://127.0.0.1:43123](http://127.0.0.1:43123) **on the same machine**. You should see the **Control Room**, not the lane board.

That address is your own computer, not a public website. It does nothing until the command above is running. `npm run dev` without `-p 43123` serves port **3000** instead.

### Ports

| Service | Port | Notes |
|---------|------|--------|
| Next.js app | **43123** | Use this port in demos (starter default is 3000) |
| Postgres | 5438 | From `compose.yaml` / `DATABASE_URL` |
| Attachments S3 API | 9009 | Local RustFS |
| Attachments console | 9010 | Optional |

If ports collide, change them in `starter/compose.yaml` and the matching lines in `starter/.env`.

### Optional OpenRouter / OpenAI

Without a key the **mock** agent runs. That is enough for the demo and the video. For a live model, put this in `starter/.env` only — **never commit secrets**:

```sh
OPENAI_API_KEY=
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4o-mini
```

Restart the dev server after editing `.env`. The header shows **agent LLM** or **agent mock**.

## Demo path (~2 minutes)

1. Control Room opens on ferry case `CD-420299`. Bentley `CD-420322` is in the queue. The agent has already run; you are not waiting for it.
2. Read the problem, the dated timeline, and the facts. Each fact shows its source. The driver chat is with the driver, never the paying customer.
3. Germany → Finland stays on Finnlines (Finnstar, Finnmaid, Finnlady). Driver rest blocks a long land detour, so a sold-out sailing becomes the next ship plus a hotel in Travemünde. For `CD-420299`: hotel 23–25 Oct, Finnlady sails 26 Oct, Helsinki 28 Oct (+1 day vs the promise).
4. The **Booking draft** is prefilled (driver, vehicle, route, sailing, cabin, hotel, price). **Copy & open** copies it and opens Finnlines. The agent does not type into that site and does not buy the ticket.
5. **Approve**. The case leaves the attention queue.
6. Open `CD-420322`. Roadside stop: tow to a dealer or a workshop (ADAC). No ferries on Munich–Hamburg.

Pitch: Bahn has no on-the-road agent yet — this is that layer.

## Demo video

A 2–3 minute screen recording with voice is part of the hand-in. It shows the queue, `CD-420299` (timeline, Finnlines, booking draft, Approve), `CD-420322` (tow), and how we used coding agents.

**Video:** https://youtu.be/REPLACE_WITH_LINK

Replace that link with the public URL before you submit. The form takes the same link.

## How we built this with AI

We used Cursor coding agents on Bahn’s starter. After the judge booth we locked the scope to on the road: gather facts, work with the driver, never call the paying customer, propose options with price and time, and require Approve before any booking.

**What we asked for.** An attention queue and one decision card (problem, facts with sources, options, booking draft, Copy & open, Approve / Change). Demo seeds `CD-420299` and `CD-420322`. Urgency in the queue. A mock path so the demo runs without API keys. Later: run every queued case in the background so the operator opens a finished decision, and prefill the booking draft so the person only reviews it.

**What we checked.** Both demo cases ourselves: Book links, the draft fields, Approve clearing the queue, Change re-run with a note, a narrow viewport, and the mock path with no API key. We also checked that a Germany–Finland case never offers a drive that skips the ferry, and that the inland Bentley never offers a ferry.

**What we threw away.** A Tallinn drive, once driver rest made it nonsense. Ferry options on the Munich–Hamburg Bentley. A Choose-a-path UI. Clock times on the timeline. The lane board as the primary screen. Finnish product copy. Auto-booking. A sticky approve bar that blocked Book clicks. Filling the Finnlines or ADAC form from our page — the browser will not allow it, so Copy & open copies the draft instead.

**Where we did not take the first answer.** The first card buried the problem under the options. The first ferry list included lines that do not sail Travemünde–Helsinki. The first Germany–Finland plan tried to skip the ship. The agent used to start only when the operator opened the card; that made the person wait, so every queued case now runs in the background and the result is stored. Approve looked tappable while it was disabled; it now explains what is missing.

## Notes

- `npm run db:seed` replaces the challenge snapshot. The `agent_runs` table has no foreign key into the seed tables, so reseeding stays safe.
- Fresh clones need `db:push`, `db:seed`, and `attachments:seed` as above. If you already have a database and only pulled new app code, reload the Control Room; you do not have to re-seed.
- To put an already approved demo case back in the queue: `npm run agent:clear-decisions` inside `starter/`, then hard-refresh.
- All names and messages are fictional. Do not commit `.env` or API keys.
