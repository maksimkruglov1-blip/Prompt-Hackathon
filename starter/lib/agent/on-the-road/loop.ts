import "server-only"

import { randomUUID } from "crypto"
import { loadOrder } from "@/lib/present/load"
import { str } from "@/lib/present/bundle"
import { fmtRange } from "@/lib/present/time"
import { saveRun } from "../store"
import type { AgentDecision, AgentFact, AgentRunRecord, DecisionOption, DeliveryTiming, OpsBookingField } from "../types"
import { resolveCurrentLocation } from "../current-location"
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools"
import { searchTripCatalog, type TripCatalogEntry } from "./trip-catalog"

const FERRY_BOOKING_FIELDS: OpsBookingField[] = [
  {
    key: "driverPassengerName",
    label: "Driver / passenger name on ferry ticket",
    placeholder: "As on ID",
    required: true,
    reason: "Agent cannot book under a name — ops confirms with the driver.",
  },
  {
    key: "driverPhone",
    label: "Driver phone",
    placeholder: "+49 …",
    required: true,
    reason: "Agent may message the driver in-app only after ops confirms the number to use.",
  },
  {
    key: "ferryBookingRef",
    label: "Ferry booking reference",
    placeholder: "Leave blank until booked",
    required: false,
    reason: "No real purchase — ops pastes the reference after they book.",
  },
  {
    key: "hotelGuestName",
    label: "Hotel guest name",
    placeholder: "Usually the driver",
    required: true,
    reason: "Agent never fills lodging contacts or cards.",
  },
  {
    key: "hotelConfirmationContact",
    label: "Hotel confirmation email / phone",
    placeholder: "ops@… or hotel desk number",
    required: true,
    reason: "Ops owns the hotel relationship; agent does not contact vendors as the customer.",
  },
  {
    key: "customerNotifyNote",
    label: "Note for customer update (ops sends)",
    placeholder: "Promise move / ETA the dealer should hear",
    required: false,
    reason: "Agent must not message the paying customer — ops writes and sends.",
  },
]

const SYSTEM = `You are Bahn's on-the-road operations agent.
You help freelance drivers who are already moving a car: breakdowns, warning lights, missed ferries, delays.
Rules:
- Never contact the paying customer (dealer/buyer). Drivers and pickup sites are fine.
- Do cheap work first: ask the driver, look up the order, gather facts, estimate recovery.
- For ferry / sailing / lodging plans: you MUST call search_trips (origin → destination, prefer=ferry) BEFORE proposing options. For roadside tow plans, call search_trips with prefer=tow (and/or estimate_recovery).
- When proposing options, copy lineName, priceEur, priceLabel, timeLabel, delayLabel, components, and bookUrl ONLY from search_trips tool results. Never invent booking URLs.
- Never book a ferry, hotel, or tow; never change a delivery promise; never message the customer without human approval. Ops opens bookUrl and books.
- Finish by proposing two to four concrete alternatives for a human in operations. For ferry cases, each option should be a different ferry line/carrier with price, time, and bookUrl.
- Write clear ops-facing English. Cite facts you gathered.`

type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: ChatToolCall[]
}

type ChatToolCall = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

function uniqFacts(facts: AgentFact[]): AgentFact[] {
  const seen = new Set<string>()
  const out: AgentFact[] = []
  for (const fact of facts) {
    const key = `${fact.label}|${fact.value}|${fact.source}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fact)
  }
  return out
}

const TOW_BOOKING_DEALER: OpsBookingField[] = [
  {
    key: "towDispatchContact",
    label: "Tow dispatch phone / case ref",
    placeholder: "After you book the truck",
    required: true,
    reason: "Agent quotes only — ops places the booking and records the contact.",
  },
  {
    key: "customerNotifyNote",
    label: "Note for customer update (ops sends)",
    placeholder: "Late delivery / recovery plan",
    required: false,
    reason: "Agent must not message the paying customer.",
  },
]

const TOW_BOOKING_WORKSHOP: OpsBookingField[] = [
  {
    key: "workshopContact",
    label: "Workshop booking contact",
    placeholder: "Desk phone or email",
    required: true,
    reason: "Ops confirms the workshop; agent does not book.",
  },
  {
    key: "customerNotifyNote",
    label: "Note for customer update (ops sends)",
    placeholder: "Diagnosis hold / new ETA",
    required: false,
    reason: "Agent must not message the paying customer.",
  },
]

function tripToFerryOption(entry: TripCatalogEntry, orderRef: string): DecisionOption {
  const withHotel = entry.kind === "ferry_hotel"
  return {
    id: entry.id,
    lineName: entry.lineName,
    title: entry.title,
    summary: entry.summary,
    priceEur: entry.priceEur,
    priceLabel: entry.priceLabel,
    etaHours: entry.etaHours,
    timeLabel: entry.timeLabel,
    delayLabel: entry.delayLabel,
    opsNext: withHotel
      ? `Book ${entry.lineName}, then fill passenger/hotel contacts.`
      : `Book ${entry.lineName}, then fill passenger contacts.`,
    implications: `${entry.lineName} · ${entry.departureWindow} · ${entry.durationLabel}. bookUrl from search_trips only.`,
    requiresApproval: withHotel
      ? ["book_ferry", "book_hotel", "update_delivery_promise", "customer_message"]
      : ["book_ferry", "update_delivery_promise", "customer_message"],
    kind: withHotel ? "ferry_hotel" : "ferry",
    components: entry.components,
    bookingFields: withHotel ? FERRY_BOOKING_FIELDS : FERRY_BOOKING_FIELDS.filter((field) => !field.key.startsWith("hotel")),
    bookUrl: entry.bookUrl,
  }
}

function tripToTowOption(entry: TripCatalogEntry, orderRef: string, vehicle: string, destinationCity: string): DecisionOption {
  const dealer = /dealer|receiving/i.test(entry.title) || entry.id.includes("dealer")
  return {
    id: entry.id,
    lineName: entry.lineName,
    title: entry.title,
    summary: dealer
      ? `Tow the ${vehicle} toward ${destinationCity}. ${entry.summary}`
      : entry.summary,
    priceEur: entry.priceEur,
    priceLabel: entry.priceLabel,
    etaHours: entry.etaHours,
    timeLabel: entry.timeLabel,
    delayLabel: entry.delayLabel,
    opsNext: dealer
      ? "Book roadside assist, call the customer about dealer recovery, then fill dispatch contacts."
      : "Book roadside assist, confirm workshop with the customer, then fill contacts.",
    implications: dealer
      ? "Higher tow cost, but the car goes straight to the right place. Customer message from a person."
      : "Cheaper, faster pickup; journey paused until the car is roadworthy again.",
    requiresApproval: ["book_tow", "update_delivery_promise", "customer_message"],
    kind: "recovery",
    components: entry.components,
    bookingFields: dealer ? TOW_BOOKING_DEALER : TOW_BOOKING_WORKSHOP,
    bookUrl: entry.bookUrl,
  }
}

function roadsideOptions(
  orderRef: string,
  vehicle: string,
  destinationCity: string,
  trips?: TripCatalogEntry[],
): DecisionOption[] {
  const fromTool = (trips ?? []).filter((t) => t.kind === "tow").slice(0, 2)
  const catalog = fromTool.length >= 2
    ? fromTool
    : searchTripCatalog({
        origin: "Ingolstadt Germany A9",
        destination: `${destinationCity} dealer workshop`,
        prefer: "tow",
      }).slice(0, 2)
  return catalog.map((entry) => tripToTowOption(entry, orderRef, vehicle, destinationCity))
}

function ferryOptions(orderRef: string, trips?: TripCatalogEntry[]): DecisionOption[] {
  const fromTool = (trips ?? []).filter((t) => t.kind === "ferry" || t.kind === "ferry_hotel")
  const catalog = fromTool.length >= 2
    ? fromTool.slice(0, 4)
    : searchTripCatalog({
        origin: "Travemünde Germany",
        destination: "Helsinki Finland",
        prefer: "ferry",
      }).slice(0, 4)
  return catalog.map((entry) => tripToFerryOption(entry, orderRef))
}

function readDeliveryPromise(loaded: NonNullable<Awaited<ReturnType<typeof loadOrder>>>): {
  start: string | null
  end: string | null
  zone: string | null
  label: string
} {
  const windows = loaded.related.time_windows ?? []
  let start: string | null = null
  let end: string | null = null
  let zone: string | null = null
  for (const row of windows) {
    if (str(row.details.purpose) !== "CUSTOMER_DELIVERY_PROMISE") continue
    start = str(row.details.start_at)
    end = str(row.details.end_at)
    zone = str(row.details.timezone)
    break
  }
  const label = start ? fmtRange(start, end, zone) : "Promise not on record"
  return { start, end, zone, label }
}

function shiftIsoDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

function buildDeliveryTiming(input: {
  loaded: NonNullable<Awaited<ReturnType<typeof loadOrder>>>
  scenario: "safety" | "ferry" | "generic"
}): DeliveryTiming {
  const promise = readDeliveryPromise(input.loaded)
  const promisedLabel = promise.start
    ? `Promised ${promise.label}`
    : "Promised delivery not on record"

  if (input.scenario === "ferry") {
    const expectedStart = promise.start ? shiftIsoDays(promise.start, 1) : null
    const expectedEnd = promise.end ? shiftIsoDays(promise.end, 1) : null
    const expectedRange = expectedStart ? fmtRange(expectedStart, expectedEnd, promise.zone) : "next day evening"
    return {
      promisedLabel,
      expectedLabel: `Now expected ${expectedRange}`,
      impactLabel: "+1 day vs promise · overnight sailing lost",
      tone: "warn",
    }
  }

  if (input.scenario === "safety") {
    const expectedStart = promise.start ? shiftIsoDays(promise.start, 1) : null
    const expectedEnd = promise.end ? shiftIsoDays(promise.end, 1) : null
    const expectedRange = expectedStart ? fmtRange(expectedStart, expectedEnd, promise.zone) : "tomorrow evening"
    return {
      promisedLabel,
      expectedLabel: `Now expected ${expectedRange}`,
      impactLabel: "+1 day vs promise · car cannot continue",
      tone: "danger",
    }
  }

  return {
    promisedLabel,
    expectedLabel: "Now expected — pending ops decision",
    impactLabel: "Promise at risk",
    tone: "warn",
  }
}

function buildMockDecision(input: {
  orderId: string
  reference: string
  vehicle: string
  customer: string
  destinationCity: string
  signal: string | null
  facts: AgentFact[]
  actions: ToolContext["actions"]
  tripResults?: TripCatalogEntry[]
  loaded: NonNullable<Awaited<ReturnType<typeof loadOrder>>>
}): AgentDecision {
  const isSafety = input.signal === "SAFETY_STOP" || input.facts.some((f) => f.label === "SAFETY_STOP")
  const isFerry = (input.signal ?? "").includes("FERRY") || input.facts.some((f) => f.label.includes("FERRY"))

  const location = resolveCurrentLocation(input.loaded, null, input.facts)
  if (location.known && !input.facts.some((f) => /^current location$/i.test(f.label))) {
    input.facts.push({
      label: "Current location",
      value: location.label,
      source: location.source,
      sourceKind: "tool",
    })
  }

  if (isSafety) {
    const options = roadsideOptions(input.reference, input.vehicle, input.destinationCity, input.tripResults)
    return {
      problem: "Red warning light — car stopped, driver is safe",
      currentLocation: location.label,
      deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: "safety" }),
      happened: `Driver stopped the ${input.vehicle} on ${input.reference} after a red warning light. They are safe at a motorway service area. The car should not be driven further.`,
      summary: "Choose a recovery path",
      facts: uniqFacts(input.facts),
      actions: input.actions,
      options,
      customerContact: "blocked",
      recommendationId: options[0]?.id ?? "trip-tow-dealer",
    }
  }

  if (isFerry) {
    const options = ferryOptions(input.reference, input.tripResults)
    // Prefer tonight / soonest passenger sailing as the recommended plan; cheaper freight stays as an alternative.
    const recommended =
      options.find((o) => o.id === "trip-tallink-hel-tra")
      ?? options.find((o) => /tonight|evening/i.test(`${o.title} ${o.timeLabel}`))
      ?? options.find((o) => o.kind === "ferry_hotel")
      ?? options[0]
    return {
      problem: "Overnight ferry sold out — need sailing + lodging plan",
      currentLocation: location.label,
      deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: "ferry" }),
      happened: `Ferry risk on ${input.reference}: the planned overnight crossing is sold out. The driver needs a replacement sailing and, if the gap is overnight, a hotel. Options come from search_trips with real book links.`,
      summary: "Choose a ferry line",
      facts: uniqFacts(input.facts),
      actions: input.actions,
      options,
      customerContact: "blocked",
      recommendationId: recommended?.id ?? null,
    }
  }

  const options = roadsideOptions(input.reference, input.vehicle, input.destinationCity, input.tripResults)
  return {
    problem: `Order ${input.reference} needs a person to decide`,
    currentLocation: location.label,
    deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: "generic" }),
    happened: `Something on ${input.reference} needs a person. The agent gathered what it could from the records and the driver.`,
    summary: "Choose an option",
    facts: uniqFacts(input.facts),
    actions: input.actions,
    options,
    customerContact: "blocked",
    recommendationId: options[0]?.id ?? "trip-tow-dealer",
  }
}

async function runToolSequence(orderId: string): Promise<{
  ctx: ToolContext
  loaded: NonNullable<Awaited<ReturnType<typeof loadOrder>>>
  meta: { reference: string; vehicle: string; customer: string; destinationCity: string; signal: string | null }
}> {
  const now = new Date().toISOString()
  const ctx: ToolContext = { orderId, now, actions: [], facts: [] }
  const loaded = await loadOrder(orderId)
  if (!loaded) throw new Error("Order not found")

  await executeTool(ctx, "lookup_order", {})
  await executeTool(ctx, "gather_facts", {})

  const signals = loaded.alerts.map((a) => a.signal)
  const isSafety = signals.includes("SAFETY_STOP")
  const isFerry = signals.some((s) => s.includes("FERRY"))

  if (isSafety) {
    await executeTool(ctx, "ask_driver", { question: "Are you and the car in a safe place?" })
    await executeTool(ctx, "ask_driver", { question: "Where exactly are you right now?" })
    await executeTool(ctx, "ask_driver", { question: "Can you send a dashboard photo of the warning light?" })
    await executeTool(ctx, "estimate_recovery", { destination: "dealer" })
    await executeTool(ctx, "estimate_recovery", { destination: "workshop" })
    const origin = loaded.pickup ? `${loaded.pickup.city}, ${loaded.pickup.country}` : "Ingolstadt, Germany"
    const destination = loaded.delivery ? `${loaded.delivery.city}, ${loaded.delivery.country}` : "Hamburg, Germany"
    await executeTool(ctx, "search_trips", { origin, destination, prefer: "tow", vehicleNote: "Cannot be driven — needs tow" })
  } else if (isFerry) {
    await executeTool(ctx, "ask_driver", { question: "Are you already at check-in, and what did the terminal say about the sailing?" })
    const origin = loaded.pickup ? `${loaded.pickup.city}, ${loaded.pickup.country}` : "Travemünde, Germany"
    const destination = loaded.delivery ? `${loaded.delivery.city}, ${loaded.delivery.country}` : "Helsinki, Finland"
    await executeTool(ctx, "search_trips", {
      origin,
      destination,
      prefer: "ferry",
      earliestDeparture: "tonight",
      vehicleNote: "Vehicle + cabin preferred",
    })
  } else {
    await executeTool(ctx, "ask_driver", { question: "Quick check — what is blocking you right now?" })
  }

  const vehicle = loaded.items[0]?.vehicle
  const open = loaded.alerts.find((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
  return {
    ctx,
    loaded,
    meta: {
      reference: loaded.order.reference,
      vehicle: vehicle ? `${vehicle.make} ${vehicle.model}` : "Vehicle",
      customer: loaded.customer?.name ?? "Customer",
      destinationCity: loaded.delivery?.city ?? "destination",
      signal: open?.signal ?? null,
    },
  }
}

function applyOpsGuidance(decision: AgentDecision, guidance: string | null | undefined): AgentDecision {
  const note = guidance?.trim()
  if (!note) return decision
  const lower = note.toLowerCase()
  const options = decision.options
  let recommendationId = decision.recommendationId
  if (/workshop|garage|cheaper tow|local shop/i.test(lower)) {
    recommendationId = options.find((o) => /workshop/i.test(o.id) || /workshop/i.test(o.title))?.id ?? recommendationId
  } else if (/dealer|receiving|customer.?s site|straight/i.test(lower)) {
    recommendationId = options.find((o) => /dealer/i.test(o.id) || /dealer/i.test(o.title))?.id ?? recommendationId
  } else if (/cheap|lowest|finnlines|no hotel|freight/i.test(lower)) {
    recommendationId = [...options].sort((a, b) => a.priceEur - b.priceEur)[0]?.id ?? recommendationId
  } else if (/tonight|tallink|fast|evening|soonest/i.test(lower)) {
    recommendationId = options.find((o) => /tallink|tonight|evening/i.test(`${o.id} ${o.title} ${o.lineName}`))?.id
      ?? [...options].sort((a, b) => (a.etaHours ?? 99) - (b.etaHours ?? 99))[0]?.id
      ?? recommendationId
  } else if (/viking|morning/i.test(lower)) {
    recommendationId = options.find((o) => /viking|morning/i.test(`${o.id} ${o.title} ${o.lineName}`))?.id ?? recommendationId
  }
  return {
    ...decision,
    recommendationId: recommendationId ?? decision.recommendationId,
    summary: `Ops asked for a new plan: ${note.slice(0, 120)}`,
    happened: `${decision.happened} Ops change note: ${note}`,
    facts: uniqFacts([
      ...decision.facts,
      { label: "Ops change note", value: note, source: "Control room Change", sourceKind: "tool" },
    ]),
  }
}

/** Deterministic mock LLM path: runs tools, then returns two options. */
export async function runMockAgent(orderId: string, opts?: { opsGuidance?: string | null }): Promise<AgentRunRecord> {
  const { ctx, meta, loaded } = await runToolSequence(orderId)
  let decision = buildMockDecision({
    orderId,
    reference: meta.reference,
    vehicle: meta.vehicle,
    customer: meta.customer,
    destinationCity: meta.destinationCity,
    signal: meta.signal,
    facts: ctx.facts,
    actions: ctx.actions,
    tripResults: ctx.tripResults,
    loaded,
  })
  decision = applyOpsGuidance(decision, opts?.opsGuidance)
  const now = new Date().toISOString()
  const record: AgentRunRecord = {
    id: `run-${randomUUID()}`,
    orderId,
    status: "pending",
    mode: "mock",
    decision,
    selectedOptionId: null,
    changeNote: null,
    opsDetails: null,
    createdAt: now,
    updatedAt: now,
    toolTrace: ctx.actions,
  }
  return saveRun(record)
}

async function callOpenAI(messages: LlmMessage[]): Promise<{ content: string | null; tool_calls?: ChatToolCall[] }> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_API_KEY missing")
  const model = process.env.OPENAI_MODEL ?? "openai/gpt-4o-mini"
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")
  const openRouter = /openrouter\.ai/i.test(base)

  const tools = TOOL_DEFINITIONS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  }
  // OpenRouter asks for these attribution headers (optional env overrides).
  if (openRouter) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER?.trim() || "http://127.0.0.1:43123"
    headers["X-Title"] = process.env.OPENROUTER_X_TITLE?.trim() || "Bahn Control Room"
  }

  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages,
      tools,
      tool_choice: "auto",
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`LLM error ${response.status}: ${text.slice(0, 400)}`)
  }
  const json = await response.json() as {
    choices: { message: { content?: string | null; tool_calls?: ChatToolCall[] } }[]
  }
  const message = json.choices[0]?.message
  return { content: message?.content ?? null, tool_calls: message?.tool_calls }
}

function normalizeOption(raw: Partial<DecisionOption>, fallback: DecisionOption): DecisionOption {
  const priceEur = typeof raw.priceEur === "number" ? raw.priceEur : fallback.priceEur
  const etaHours = typeof raw.etaHours === "number" ? raw.etaHours : (raw.etaHours === null ? null : fallback.etaHours)
  return {
    id: String(raw.id ?? fallback.id),
    title: String(raw.title ?? fallback.title),
    summary: String(raw.summary ?? fallback.summary),
    priceEur,
    priceLabel: String(raw.priceLabel ?? `€${priceEur}`),
    etaHours,
    timeLabel: String(raw.timeLabel ?? fallback.timeLabel),
    delayLabel: String(raw.delayLabel ?? fallback.delayLabel),
    opsNext: String(raw.opsNext ?? fallback.opsNext),
    implications: String(raw.implications ?? fallback.implications),
    requiresApproval: Array.isArray(raw.requiresApproval) ? raw.requiresApproval.map(String) : fallback.requiresApproval,
    kind: raw.kind ?? fallback.kind,
    lineName: raw.lineName ?? fallback.lineName,
    components: raw.components ?? fallback.components,
    bookingFields: raw.bookingFields ?? fallback.bookingFields,
    bookUrl: typeof raw.bookUrl === "string" && raw.bookUrl.startsWith("http")
      ? raw.bookUrl
      : fallback.bookUrl,
  }
}

function parseDecisionFromText(text: string, fallback: AgentDecision): AgentDecision {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return fallback
  try {
    const parsed = JSON.parse(match[0]) as Partial<AgentDecision>
    if (!parsed.options || !Array.isArray(parsed.options) || parsed.options.length < 2) return fallback
    const options = parsed.options.slice(0, 3).map((raw, index) =>
      normalizeOption(raw as Partial<DecisionOption>, fallback.options[Math.min(index, fallback.options.length - 1)]!),
    )
    return {
      problem: String(parsed.problem ?? fallback.problem),
      currentLocation: typeof (parsed as Partial<AgentDecision>).currentLocation === "string"
        ? (parsed as Partial<AgentDecision>).currentLocation
        : fallback.currentLocation,
      deliveryTiming: (parsed as Partial<AgentDecision>).deliveryTiming ?? fallback.deliveryTiming,
      happened: String(parsed.happened ?? fallback.happened),
      summary: String(parsed.summary ?? fallback.summary),
      facts: fallback.facts,
      actions: fallback.actions,
      options,
      customerContact: "blocked",
      recommendationId: parsed.recommendationId ? String(parsed.recommendationId) : fallback.recommendationId,
    }
  } catch {
    return fallback
  }
}

/** True when a stored run is missing scannable fields, booking fields, or still has Finnish UI copy. */
export function runNeedsPriceTimeRefresh(run: AgentRunRecord): boolean {
  const decision = run.decision
  if (!decision.problem?.trim()) return true
  if (!decision.deliveryTiming?.promisedLabel || !decision.deliveryTiming?.expectedLabel) return true
  if (decision.options.some((option) => typeof option.priceEur !== "number" || !option.timeLabel || !option.priceLabel)) return true
  if (decision.options.some((option) => (option.kind === "ferry_hotel" || option.kind === "ferry") && !(option.bookingFields?.length))) return true
  if (decision.options.some((option) => option.id === "next-sailing" || option.id === "reroute-land" || option.id === "ferry-evening-hotel-a" || option.id === "ferry-morning-hotel-b")) return true
  if (decision.options.some((option) => (option.kind === "ferry_hotel" || option.kind === "ferry") && !option.lineName)) return true
  if (decision.options.some((option) => !(option.components?.length))) return true
  if (decision.options.some((option) => (option.kind === "ferry_hotel" || option.kind === "ferry" || option.kind === "recovery") && !option.bookUrl)) return true
  if (decision.options.some((option) => /NordSea Link|Baltic Gate|Silja Route Express/.test(option.lineName ?? ""))) return true
  // Refresh when catalog time labels / copy were shortened for the judge layout.
  if (decision.options.some((option) => /Dep ~|tow ETA|does not purchase|agent never books/i.test(`${option.timeLabel} ${option.summary}`))) return true
  const blob = [
    decision.problem,
    decision.summary,
    ...decision.options.flatMap((option) => [option.title, option.timeLabel, option.delayLabel, option.opsNext]),
  ].join(" ")
  return /[äöÄÖ]|Hinaus|Toimitus|varoitus|Lautt|pisteelle|korjaamo|Hyväksy|Valitse/.test(blob)
}

/** Real LLM loop with tools; falls back to mock decision shaping if the model output is incomplete. */
export async function runLlmAgent(orderId: string): Promise<AgentRunRecord> {
  const loaded = await loadOrder(orderId)
  if (!loaded) throw new Error("Order not found")

  const now = new Date().toISOString()
  const ctx: ToolContext = { orderId, now, actions: [], facts: [] }
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Work order ${loaded.order.reference} (${orderId}). Gather facts with tools, then reply with JSON only.
For ferry / sailing cases you MUST call search_trips before proposing options. Copy bookUrl and lineName from tool results only — never invent URLs. Do not book.
{"problem":"Overnight ferry sold out — need sailing + lodging plan","happened":"...","summary":"...","recommendationId":"option-id","options":[{"id":"trip-tallink-hel-tra","lineName":"Tallink Silja","title":"...","summary":"...","priceEur":540,"priceLabel":"€540","etaHours":8,"timeLabel":"...","delayLabel":"Delivery +1 day","bookUrl":"https://www.tallinksilja.com/","components":[{"label":"Ferry ticket","priceLabel":"€445","timeLabel":"..."},{"label":"Hotel","priceLabel":"€95","timeLabel":"..."}],"opsNext":"...","implications":"...","requiresApproval":["book_ferry","book_hotel"]}]}
Include a short English "problem" line. Propose 2–4 options. Ferry cases: each option a different lineName (carrier) with bookUrl from search_trips. Every option MUST include priceEur, priceLabel, timeLabel, delayLabel, bookUrl, and components[] that break down the total. Price and time are primary. Write ops-facing English. Do not contact the customer.`,
    },
  ]

  for (let step = 0; step < 8; step += 1) {
    const result = await callOpenAI(messages)
    if (result.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.tool_calls,
      })
      for (const call of result.tool_calls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown> } catch { args = {} }
        const toolResult = await executeTool(ctx, call.function.name, args)
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResult.ok ? toolResult.output : toolResult.error,
        })
      }
      continue
    }

    const vehicle = loaded.items[0]?.vehicle
    const open = loaded.alerts.find((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
    const fallback = buildMockDecision({
      orderId,
      reference: loaded.order.reference,
      vehicle: vehicle ? `${vehicle.make} ${vehicle.model}` : "Vehicle",
      customer: loaded.customer?.name ?? "Customer",
      destinationCity: loaded.delivery?.city ?? "destination",
      signal: open?.signal ?? null,
      facts: ctx.facts,
      actions: ctx.actions,
      tripResults: ctx.tripResults,
      loaded,
    })
    const decision = parseDecisionFromText(result.content ?? "", fallback)
    // Prefer catalog bookUrls from search_trips when the model omits or invents links
    if (ctx.tripResults?.length) {
      const byId = new Map(ctx.tripResults.map((t) => [t.id, t]))
      decision.options = decision.options.map((option) => {
        const hit = byId.get(option.id) ?? ctx.tripResults?.find((t) => t.lineName === option.lineName)
        if (!hit) return option
        return {
          ...option,
          bookUrl: hit.bookUrl,
          lineName: option.lineName ?? hit.lineName,
          components: option.components?.length ? option.components : hit.components,
        }
      })
    }
    decision.facts = uniqFacts(ctx.facts)
    decision.actions = ctx.actions
    decision.customerContact = "blocked"
    decision.deliveryTiming = decision.deliveryTiming ?? fallback.deliveryTiming
    decision.currentLocation = decision.currentLocation ?? fallback.currentLocation ?? resolveCurrentLocation(loaded, null, ctx.facts).label

    const stamp = new Date().toISOString()
    return saveRun({
      id: `run-${randomUUID()}`,
      orderId,
      status: "pending",
      mode: "llm",
      decision,
      selectedOptionId: null,
      changeNote: null,
      opsDetails: null,
      createdAt: stamp,
      updatedAt: stamp,
      toolTrace: ctx.actions,
    })
  }

  // Too many tool steps — finish with mock shaping on gathered facts
  return runMockAgent(orderId)
}

export async function runOnTheRoadAgent(
  orderId: string,
  opts?: { opsGuidance?: string | null },
): Promise<AgentRunRecord> {
  if (process.env.OPENAI_API_KEY) {
    try {
      // Live LLM path still gathers tools; ops guidance is applied on the mock-shaped fallback path
      // and as a forced re-mock when guidance is present (hackathon demo reliability).
      if (opts?.opsGuidance?.trim()) return runMockAgent(orderId, opts)
      return await runLlmAgent(orderId)
    } catch (error) {
      console.error("LLM agent failed, falling back to mock", error)
      return runMockAgent(orderId, opts)
    }
  }
  return runMockAgent(orderId, opts)
}

export function agentMode(): "mock" | "llm" {
  return process.env.OPENAI_API_KEY ? "llm" : "mock"
}
