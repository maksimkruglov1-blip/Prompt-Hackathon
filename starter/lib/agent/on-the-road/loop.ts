import "server-only"

import { randomUUID } from "crypto"
import { loadOrder } from "@/lib/present/load"
import { str } from "@/lib/present/bundle"
import { fmtRange } from "@/lib/present/time"
import { saveRun } from "../store"
import type { AgentDecision, AgentFact, AgentRunRecord, DecisionOption, DeliveryTiming, OpsBookingField } from "../types"
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools"

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
- Never book a tow, change a delivery promise, or message the customer without human approval.
- Finish by proposing two or three concrete alternatives for a human in operations. For ferry cases, each option should be a different ferry line/carrier with price and time.
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

function roadsideOptions(orderRef: string, vehicle: string, destinationCity: string): [DecisionOption, DecisionOption] {
  return [
    {
      id: "tow-dealer",
      title: "Tow to dealer / receiving site",
      summary: `Tow the ${vehicle} to the customer's site in ${destinationCity}. Driver stays with the car until it is loaded.`,
      priceEur: 380,
      priceLabel: "€380",
      etaHours: 4,
      timeLabel: "4 h tow ETA",
      delayLabel: "Delivery tomorrow evening",
      opsNext: "Call the customer (a person, not the agent): their own roadside assist or Bahn tow to their site. Then approve the booking.",
      implications: "Higher tow cost, but the car goes straight to the right place. Customer message from a person.",
      requiresApproval: ["book_tow", "update_delivery_promise", "customer_message"],
      kind: "recovery",
      components: [
        { label: "Tow truck", priceLabel: "€310", timeLabel: "4 h ETA" },
        { label: "Driver waiting stipend", priceLabel: "€45", timeLabel: "Until loaded" },
        { label: "Service-area fee", priceLabel: "€25", timeLabel: "Mock" },
      ],
      bookingFields: [
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
      ],
    },
    {
      id: "tow-workshop",
      title: "Tow to nearby workshop",
      summary: `Tow to a workshop near Ingolstadt, diagnose the red warning, then replan the remaining leg of ${orderRef}.`,
      priceEur: 290,
      priceLabel: "€290",
      etaHours: 2.5,
      timeLabel: "2.5 h tow ETA",
      delayLabel: "Delivery +1–2 days",
      opsNext: "Call the customer for workshop preference / spend, approve the tow. Keep the driver on standby or release after handover.",
      implications: "Cheaper, faster pickup; journey paused until the car is roadworthy again.",
      requiresApproval: ["book_tow", "update_delivery_promise", "customer_message"],
      kind: "recovery",
      components: [
        { label: "Tow truck", priceLabel: "€240", timeLabel: "2.5 h ETA" },
        { label: "Workshop intake hold", priceLabel: "€35", timeLabel: "Mock" },
        { label: "Driver waiting stipend", priceLabel: "€15", timeLabel: "Short handoff" },
      ],
      bookingFields: [
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
      ],
    },
  ]
}

function ferryOptions(orderRef: string): DecisionOption[] {
  return [
    {
      id: "line-nordsea-evening",
      lineName: "NordSea Link",
      title: "Tonight 23:40 · Travemünde → Helsinki",
      summary: `Overnight sold out on ${orderRef}. NordSea Link still has space on the late sailing; driver stays at Kajuta Inn before boarding (mock).`,
      priceEur: 514,
      priceLabel: "€514",
      etaHours: 6,
      timeLabel: "Sailing 23:40 · ~27 h sea",
      delayLabel: "Delivery +1 day",
      opsNext: "Approve NordSea Link, then fill passenger/hotel contacts. Ops books ferry + hotel (mock). Person updates the customer.",
      implications: "Mock: NordSea Link cabin+vehicle €425 + Kajuta Inn €89. Fastest recovery among the three lines.",
      requiresApproval: ["book_ferry", "book_hotel", "update_delivery_promise", "customer_message"],
      kind: "ferry_hotel",
      components: [
        { label: "Ferry ticket (cabin + vehicle)", priceLabel: "€425", timeLabel: "23:40 tonight" },
        { label: "Hotel · Kajuta Inn", priceLabel: "€89", timeLabel: "Check-in 20:00" },
      ],
      bookingFields: FERRY_BOOKING_FIELDS,
    },
    {
      id: "line-balticgate-morning",
      lineName: "Baltic Gate Ferries",
      title: "Tomorrow 08:15 · Rostock → Vuosaari",
      summary: `Baltic Gate morning freight sailing for ${orderRef}. Driver overnight at Terminal Lodge; boarding after rest.`,
      priceEur: 455,
      priceLabel: "€455",
      etaHours: 14,
      timeLabel: "Sailing 08:15 · ~26 h sea",
      delayLabel: "Delivery +1 day",
      opsNext: "Approve Baltic Gate, then fill contacts. Ops books ferry + lodge. Person updates the promise.",
      implications: "Mock: Baltic Gate €310 + Terminal Lodge €145. Cheaper line, later departure.",
      requiresApproval: ["book_ferry", "book_hotel", "update_delivery_promise", "customer_message"],
      kind: "ferry_hotel",
      components: [
        { label: "Ferry ticket (cabin + vehicle)", priceLabel: "€310", timeLabel: "08:15 tomorrow" },
        { label: "Hotel · Terminal Lodge", priceLabel: "€145", timeLabel: "Check-in 22:00" },
      ],
      bookingFields: FERRY_BOOKING_FIELDS,
    },
    {
      id: "line-siljaroute-afternoon",
      lineName: "Silja Route Express",
      title: "Tomorrow 14:30 · Travemünde → Helsinki",
      summary: `Silja Route Express afternoon sailing — more cabin availability for ${orderRef}, no hotel if the driver waits at the terminal rest area.`,
      priceEur: 390,
      priceLabel: "€390",
      etaHours: 20,
      timeLabel: "Sailing 14:30 · ~28 h sea",
      delayLabel: "Delivery +2 days",
      opsNext: "Approve Silja Route Express, fill passenger contacts. Ops books ferry only (mock). Person updates the customer.",
      implications: "Mock: Silja Route Express cabin+vehicle €390. Lowest package price; longest wait before departure; hotel optional.",
      requiresApproval: ["book_ferry", "update_delivery_promise", "customer_message"],
      kind: "ferry",
      components: [
        { label: "Ferry ticket (cabin + vehicle)", priceLabel: "€390", timeLabel: "14:30 tomorrow" },
        { label: "Hotel", priceLabel: "€0", timeLabel: "Not included" },
      ],
      bookingFields: FERRY_BOOKING_FIELDS.filter((field) => !field.key.startsWith("hotel")),
    },
  ]
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
  loaded: NonNullable<Awaited<ReturnType<typeof loadOrder>>>
}): AgentDecision {
  const isSafety = input.signal === "SAFETY_STOP" || input.facts.some((f) => f.label === "SAFETY_STOP")
  const isFerry = (input.signal ?? "").includes("FERRY") || input.facts.some((f) => f.label.includes("FERRY"))

  if (isSafety) {
    return {
      problem: "Red warning light — car stopped, driver is safe",
      deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: "safety" }),
      happened: `Driver stopped the ${input.vehicle} on ${input.reference} after a red warning light. They are safe at a motorway service area. The car should not be driven further.`,
      summary: "Choose a recovery path",
      facts: uniqFacts(input.facts),
      actions: input.actions,
      options: roadsideOptions(input.reference, input.vehicle, input.destinationCity),
      customerContact: "blocked",
      recommendationId: "tow-dealer",
    }
  }

  if (isFerry) {
    return {
      problem: "Overnight ferry sold out — need sailing + lodging plan",
      deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: "ferry" }),
      happened: `Ferry risk on ${input.reference}: the planned overnight crossing is sold out. The driver needs a replacement sailing and, if the gap is overnight, a hotel. Quotes are mock only — no booking until ops approves and fills contacts.`,
      summary: "Choose a ferry line",
      facts: uniqFacts(input.facts),
      actions: input.actions,
      options: ferryOptions(input.reference),
      customerContact: "blocked",
      recommendationId: "line-nordsea-evening",
    }
  }

  return {
    problem: `Order ${input.reference} needs a person to decide`,
    deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: "generic" }),
    happened: `Something on ${input.reference} needs a person. The agent gathered what it could from the records and the driver.`,
    summary: "Choose an option",
    facts: uniqFacts(input.facts),
    actions: input.actions,
    options: roadsideOptions(input.reference, input.vehicle, input.destinationCity),
    customerContact: "blocked",
    recommendationId: "tow-dealer",
  }
}

function pushFerryQuotes(ctx: ToolContext) {
  const lines = [
    "NordSea Link: tonight 23:40 Travemünde→Helsinki cabin+vehicle €425 + Kajuta Inn €89 = €514.",
    "Baltic Gate Ferries: tomorrow 08:15 Rostock→Vuosaari cabin+vehicle €310 + Terminal Lodge €145 = €455.",
    "Silja Route Express: tomorrow 14:30 Travemünde→Helsinki cabin+vehicle €390 (no hotel) = €390.",
    "Agent does not fill passenger names, phones, or vendor contacts — ops completes after Approve.",
  ]
  for (const line of lines) {
    ctx.facts.push({ label: "Travel quote", value: line, source: "Mock ferry/hotel pricing", sourceKind: "tool" })
  }
  ctx.actions.push({
    tool: "quote_ferry_hotel",
    summary: "Quoted three ferry lines with hotels where needed (mock; no booking)",
    at: ctx.now,
    detail: lines.join(" "),
  })
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
    await executeTool(ctx, "ask_driver", { question: "Where exactly are you, and can you send a dashboard photo of the warning light?" })
    await executeTool(ctx, "estimate_recovery", { destination: "dealer" })
    await executeTool(ctx, "estimate_recovery", { destination: "workshop" })
  } else   if (isFerry) {
    await executeTool(ctx, "ask_driver", { question: "Are you already at check-in, and what did the terminal say about the sailing?" })
    pushFerryQuotes(ctx)
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

/** Deterministic mock LLM path: runs tools, then returns two options. */
export async function runMockAgent(orderId: string): Promise<AgentRunRecord> {
  const { ctx, meta, loaded } = await runToolSequence(orderId)
  const decision = buildMockDecision({
    orderId,
    reference: meta.reference,
    vehicle: meta.vehicle,
    customer: meta.customer,
    destinationCity: meta.destinationCity,
    signal: meta.signal,
    facts: ctx.facts,
    actions: ctx.actions,
    loaded,
  })
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
      content: `Work order ${loaded.order.reference} (${orderId}). Gather facts with tools, then reply with JSON only:
{"problem":"Overnight ferry sold out — need sailing + lodging plan","happened":"...","summary":"...","recommendationId":"option-id","options":[{"id":"...","lineName":"NordSea Link","title":"...","summary":"...","priceEur":514,"priceLabel":"€514","etaHours":6,"timeLabel":"Sailing 23:40","delayLabel":"Delivery +1 day","components":[{"label":"Ferry ticket","priceLabel":"€425","timeLabel":"..."},{"label":"Hotel","priceLabel":"€89","timeLabel":"..."}],"opsNext":"...","implications":"...","requiresApproval":["book_ferry","book_hotel"]}]}
Include a short English "problem" line. Propose 2–3 options. Ferry cases: each option a different lineName (carrier). Every option MUST include priceEur, priceLabel, timeLabel, delayLabel, and components[] that break down the total. Price and time are primary. Write ops-facing English. Do not contact the customer.`,
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
      loaded,
    })
    const decision = parseDecisionFromText(result.content ?? "", fallback)
    decision.facts = uniqFacts(ctx.facts)
    decision.actions = ctx.actions
    decision.customerContact = "blocked"
    decision.deliveryTiming = decision.deliveryTiming ?? fallback.deliveryTiming

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

export async function runOnTheRoadAgent(orderId: string): Promise<AgentRunRecord> {
  if (process.env.OPENAI_API_KEY) {
    try {
      return await runLlmAgent(orderId)
    } catch (error) {
      console.error("LLM agent failed, falling back to mock", error)
      return runMockAgent(orderId)
    }
  }
  return runMockAgent(orderId)
}

export function agentMode(): "mock" | "llm" {
  return process.env.OPENAI_API_KEY ? "llm" : "mock"
}
