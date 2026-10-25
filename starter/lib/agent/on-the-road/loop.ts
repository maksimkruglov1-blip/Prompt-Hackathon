import "server-only"

import { randomUUID } from "crypto"
import { loadOrder } from "@/lib/present/load"
import { obj, originPickupPoint, recordedAt, rows, str } from "@/lib/present/bundle"
import { fmtDay, fmtDayRange } from "@/lib/present/time"
import { saveRun } from "../store"
import type { AgentDecision, AgentFact, AgentRunRecord, DecisionOption, DeliveryTiming } from "../types"
import { resolveCurrentLocation } from "../current-location"
import {
  bookingDraftHasRelativeDates,
  bookingFieldsNeedPrefill,
  buildFerryBookingDraft,
  buildTowBookingDraft,
  type BookingDraftContext,
} from "./booking-draft"
import { resolveFerrySchedule } from "./ferry-schedule"
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools"
import { inferCountryCode, needsSeaCrossing, searchTripCatalog, TRIP_CATALOG, type TripCatalogEntry } from "./trip-catalog"

const SYSTEM = `You are Bahn's on-the-road operations agent.
You help freelance drivers who are already moving a car: breakdowns, warning lights, missed ferries, delays.
Rules:
- Never contact the paying customer (dealer/buyer). Drivers and pickup sites are fine.
- Do cheap work first: ask the driver, look up the order, gather facts, estimate recovery.
- Decision staging: (1) safety + location + symptom via ask_driver / facts; (2) for roadside/breakdown propose ONLY recovery (tow where? dealer / workshop) — never ferries in that step; (3) ferry/hotel search only for travel-capacity / FERRY_* sea-corridor cases.
- Corridor rule: if pickup and delivery are in the SAME country with no sea leg (e.g. Munich, DE → Hamburg, DE), this is inland — use prefer=tow / roadside recovery. NEVER recommend Tallink, Viking Line, Finnlines, or Eckerö for inland Germany.
- HARD RULE — Germany → Finland vehicle deliveries: the Travemünde/Rostock ↔ Helsinki Vuosaari Finnlines crossing is MANDATORY (ships Finnstar, Finnmaid, Finnlady, ~once daily, ~27–30 h). Never propose skipping that ferry, an alternate crossing, a road detour around the sea leg, Tallink/Viking as Travemünde→Helsinki, or any land reroute that replaces the Finnlines sailing. Driver rest hours forbid long extra driving; if tonight is sold out, propose the next Finnlines sailing + hotel/rest at Travemünde.
- For Baltic ferry / sailing / lodging plans (Germany/Sweden ports → Finland, or FERRY_* alerts): call search_trips with prefer=ferry BEFORE proposing options. Return only Finnlines DE→FI ships for that corridor.
- For roadside stops / SAFETY_STOP / cannot-drive: ask_driver first, then estimate_recovery and search_trips with prefer=tow. Options must be tow/recovery, not ferries. Set stage to "recover".
- When proposing options, copy lineName, priceEur, priceLabel, timeLabel, delayLabel, components, and bookUrl ONLY from search_trips tool results. Never invent booking URLs.
- Never book a ferry, hotel, or tow; never change a delivery promise; never message the customer without human approval. Prefill a booking draft from order/driver/option data for ops to review; ops uses Copy & open on bookUrl — agent never fills paying-customer contacts.
- Finish by proposing two to four concrete alternatives for a human in operations. Ferry cases: different carriers. Roadside cases: dealer tow vs workshop tow.
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

function tripToFerryOption(
  entry: TripCatalogEntry,
  draftCtx: BookingDraftContext,
  promise?: { start: string | null; zone: string | null },
): DecisionOption {
  const withHotel = entry.kind === "ferry_hotel"
  const schedule = draftCtx.sailingAnchorIso
    ? resolveFerrySchedule(
      entry,
      draftCtx.sailingAnchorIso,
      draftCtx.zone ?? promise?.zone ?? null,
      promise?.start ?? draftCtx.promiseStartIso,
    )
    : null
  const sailBit = schedule ? `Sails ${schedule.sailLabel}` : entry.departureWindow
  return {
    id: entry.id,
    lineName: entry.lineName,
    title: entry.title,
    summary: entry.summary,
    priceEur: entry.priceEur,
    priceLabel: entry.priceLabel,
    etaHours: entry.etaHours,
    timeLabel: schedule
      ? `${sailBit} · ~30 h sea → ${schedule.arriveLabel}`
      : entry.timeLabel,
    delayLabel: schedule?.delayLabel ?? entry.delayLabel,
    arrivalLabel: schedule?.arriveLabel ?? null,
    opsNext: withHotel
      ? `Review booking draft → Copy & open Finnlines + hotel, then Approve.`
      : `Review booking draft → Copy & open Finnlines, then Approve.`,
    implications: schedule
      ? `${entry.lineName} · ${sailBit} · ~30 h sea · arrive ${schedule.arriveLabel}. bookUrl from search_trips only.`
      : `${entry.lineName} · ${entry.departureWindow} · ${entry.durationLabel}. bookUrl from search_trips only.`,
    requiresApproval: withHotel
      ? ["book_ferry", "book_hotel", "update_delivery_promise", "customer_message"]
      : ["book_ferry", "update_delivery_promise", "customer_message"],
    kind: withHotel ? "ferry_hotel" : "ferry",
    components: entry.components,
    bookingFields: buildFerryBookingDraft(entry, draftCtx),
    bookUrl: entry.bookUrl,
    verdict: entry.verdict ?? null,
  }
}

function tripToTowOption(
  entry: TripCatalogEntry,
  draftCtx: BookingDraftContext,
  vehicle: string,
  destinationCity: string,
): DecisionOption {
  const dealer = /dealer|receiving/i.test(entry.title) || entry.id.includes("dealer")
  const workshop = /workshop/i.test(entry.title) || entry.id.includes("workshop")
  const destinationTitle = dealer
    ? `Dealer / receiving site · ${destinationCity}`
    : workshop
      ? "Nearby workshop (diagnosis)"
      : entry.title
  return {
    id: entry.id,
    lineName: entry.lineName,
    title: dealer
      ? `Tow to dealer / receiving site (${destinationCity})`
      : workshop
        ? "Tow to nearby workshop"
        : entry.title,
    summary: dealer
      ? `Recovery path: tow the ${vehicle} toward ${destinationCity}. ${entry.summary}`
      : workshop
        ? `Recovery path: tow to a nearby workshop for diagnosis. ${entry.summary}`
        : entry.summary,
    priceEur: entry.priceEur,
    priceLabel: entry.priceLabel,
    etaHours: entry.etaHours,
    timeLabel: entry.timeLabel,
    delayLabel: entry.delayLabel,
    opsNext: dealer
      ? "Review tow draft → Copy & open ADAC, then Approve. Ops calls the dealer / customer."
      : "Review tow draft → Copy & open ADAC, then Approve. Ops confirms workshop with the customer.",
    implications: dealer
      ? "Higher tow cost, but the car goes straight to the right place. Customer message from a person."
      : "Cheaper, faster pickup; journey paused until the car is roadworthy again.",
    requiresApproval: ["book_tow", "update_delivery_promise", "customer_message"],
    kind: "recovery",
    components: entry.components,
    bookingFields: buildTowBookingDraft(entry, draftCtx, destinationTitle),
    bookUrl: entry.bookUrl,
  }
}

function roadsideOptions(
  draftCtx: BookingDraftContext,
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
  return catalog.map((entry) => tripToTowOption(entry, draftCtx, vehicle, destinationCity))
}

/** Ops-facing English: ferry required + driver rest (no alternate land crossing). */
export const DE_FI_FERRY_REST_NOTE =
  "Travemünde–Helsinki Finnlines is required. Driver rest hours block long extra driving — if tonight is sold out, book the next Finnlines sailing and rest at Travemünde."

function isFinnlinesDeFiShip(entry: { id: string; lineName?: string; title?: string }): boolean {
  return /finnstar|finnmaid|finnlady/i.test(`${entry.id} ${entry.lineName ?? ""} ${entry.title ?? ""}`)
    && !/tallinn|eckerö|eckero|tallink|viking|path\s*[ab]|skip|detour/i.test(`${entry.id} ${entry.lineName ?? ""} ${entry.title ?? ""}`)
}

function ferryOptions(
  draftCtx: BookingDraftContext,
  trips?: TripCatalogEntry[],
  promise?: { start: string | null; zone: string | null },
): DecisionOption[] {
  const fromTool = (trips ?? []).filter((t) => t.kind === "ferry" || t.kind === "ferry_hotel")
  // DE→FI hard rule: Finnstar / Finnmaid / Finnlady only — ferry mandatory, no land substitute.
  const finnShips = (entries: TripCatalogEntry[]) =>
    entries.filter((e) => isFinnlinesDeFiShip(e)).slice(0, 3)
  const searched = fromTool.length >= 2
    ? fromTool
    : searchTripCatalog({
        origin: "Travemünde Germany Leipzig sold out",
        destination: "Helsinki Vuosaari Finland",
        prefer: "ferry",
      })
  const ships = finnShips(searched)
  const fallbackShips = ships.length >= 2
    ? ships
    : finnShips(searchTripCatalog({
        origin: "Travemünde Germany",
        destination: "Helsinki Vuosaari Finland",
        prefer: "ferry",
      }))
  // Prefer hotel/rest package first when tonight is sold out, then next daily ships.
  const orderIds = ["trip-finnlady", "trip-finnmaid", "trip-finnstar"]
  const byId = new Map(fallbackShips.map((e) => [e.id, e]))
  const catalog = orderIds.map((id) => byId.get(id)).filter(Boolean) as TripCatalogEntry[]
  const rest = fallbackShips.filter((e) => !orderIds.includes(e.id))
  return [...catalog, ...rest].map((entry) => tripToFerryOption(entry, draftCtx, promise))
}

function buildDraftContext(
  loaded: NonNullable<Awaited<ReturnType<typeof loadOrder>>>,
  facts: AgentFact[],
  meta: { reference: string; vehicle: string; destinationCity: string },
): BookingDraftContext {
  const vehicle = loaded.items[0]?.vehicle as
    | {
        make?: string
        model?: string
        registration?: string | null
        vin?: string | null
        syntheticVin?: string | null
        fuel?: string | null
        year?: number | null
        modelYear?: number | null
      }
    | undefined
  const driver = loaded.drivers[0] as { displayName?: string } | undefined
  const location = resolveCurrentLocation(loaded, null, facts)
  const locationFact = facts.find((f) => /current location|where exactly|service area/i.test(`${f.label} ${f.value}`))
  const phoneFact = facts.find((f) => /phone|mobile|tel/i.test(f.label))
  const pickupLocation =
    location.known
      ? location.label
      : locationFact?.value
        ?? (loaded.pickup ? `${loaded.pickup.name}, ${loaded.pickup.city}` : "Confirm with driver")

  // Same calendar anchor as delivery timeline ferry/problem day (dates only).
  const promise = readDeliveryPromise(loaded)
  const windows = rows(loaded.bundle, "time_windows")
  const pickupWindow = windows.find((row) => str(row.details.purpose) === "SELECTED_PICKUP_SLOT")
    ?? windows.find((row) => str(row.details.purpose) === "PICKUP_AVAILABILITY")
  const pickupIso = (() => {
    const origin = originPickupPoint(loaded.bundle)
    const pickedEvent = recordedAt(loaded.bundle, "vehicle.picked_up", origin?.id)
      ?? loaded.bundle.events.find((event) => event.command === "vehicle.picked_up")
      ?? null
    if (pickedEvent) {
      const changes = obj(pickedEvent.details.changes)
      return str(changes?.occurred_at) ?? pickedEvent.recordedAt
    }
    return str(pickupWindow?.details.start_at)
  })()
  const alert = loaded.alerts.find((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
    ?? loaded.alerts[0]
    ?? null
  const problemIso = alert
    ? (alert.triggeredAt instanceof Date ? alert.triggeredAt.toISOString() : String(alert.triggeredAt))
    : null
  const sailingAnchorIso =
    problemIso && pickupIso && new Date(problemIso).getTime() < new Date(pickupIso).getTime()
      ? pickupIso
      : (problemIso ?? pickupIso)
  const zone = promise.zone ?? str(pickupWindow?.details.timezone)

  return {
    orderRef: meta.reference,
    driverName: driver?.displayName ?? null,
    driverPhone: phoneFact?.value ?? null,
    vehicleLabel: meta.vehicle,
    vehicleReg: vehicle?.registration ?? null,
    vehicleVin: vehicle?.vin ?? vehicle?.syntheticVin ?? null,
    vehicleFuel: vehicle?.fuel ?? null,
    vehicleYear: vehicle?.year ?? vehicle?.modelYear ?? null,
    pickupLocation,
    destinationLabel: meta.destinationCity,
    sailingAnchorIso,
    zone,
    promiseStartIso: promise.start,
  }
}

/** Strip any non-Finnlines / skip-ferry options from a DE→FI decision (LLM or stale runs). */
export function enforceDeFiFinnlinesOnly(options: DecisionOption[]): DecisionOption[] {
  const finn = options.filter((o) => isFinnlinesDeFiShip(o))
  if (finn.length > 0) return finn
  return options.filter((o) => o.kind === "ferry" || o.kind === "ferry_hotel")
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
  const label = start ? fmtDayRange(start, end, zone) : "Promise not on record"
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
  /** Recommended option — ferry Now expected / delay chip come from this arrival. */
  recommended?: DecisionOption | null
}): DeliveryTiming {
  const promise = readDeliveryPromise(input.loaded)
  const promisedLabel = promise.start
    ? `Promised ${promise.label}`
    : "Promised delivery not on record"

  if (input.scenario === "ferry") {
    const rec = input.recommended
    if (rec?.arrivalLabel) {
      const delay = rec.delayLabel?.replace(/^Delivery\s+/i, "") ?? "+1 day vs promise"
      return {
        promisedLabel,
        expectedLabel: `Now expected ${rec.arrivalLabel}`,
        impactLabel: delay,
        tone: "warn",
      }
    }
    const expectedStart = promise.start ? shiftIsoDays(promise.start, 1) : null
    const expectedRange = expectedStart ? fmtDayRange(expectedStart, null, promise.zone) : "next day"
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
    const expectedRange = expectedStart ? fmtDayRange(expectedStart, expectedEnd, promise.zone) : "tomorrow"
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
  const isFerrySignal = (input.signal ?? "").includes("FERRY") || input.facts.some((f) => f.label.includes("FERRY"))
  const pickupCountry = inferCountryCode(
    input.loaded.pickup ? `${input.loaded.pickup.city}, ${input.loaded.pickup.country}` : "",
  )
  const deliveryCountry = inferCountryCode(
    input.loaded.delivery ? `${input.loaded.delivery.city}, ${input.loaded.delivery.country}` : "",
  )
  const inlandSameCountry = Boolean(pickupCountry && deliveryCountry && pickupCountry === deliveryCountry)
  const seaCorridor = needsSeaCrossing({
    origin: input.loaded.pickup ? `${input.loaded.pickup.city}, ${input.loaded.pickup.country}` : "",
    destination: input.loaded.delivery ? `${input.loaded.delivery.city}, ${input.loaded.delivery.country}` : "",
    prefer: isFerrySignal ? "ferry" : "any",
  })
  // Inland DE→DE (or any same-country) roadside / moving cases never get Baltic ferries.
  const isFerry = isFerrySignal && seaCorridor && !inlandSameCountry && !isSafety

  const location = resolveCurrentLocation(input.loaded, null, input.facts)
  if (location.known && !input.facts.some((f) => /^current location$/i.test(f.label))) {
    input.facts.push({
      label: "Current location",
      value: location.label,
      source: location.source,
      sourceKind: "tool",
    })
  }

  const draftCtx = buildDraftContext(input.loaded, input.facts, {
    reference: input.reference,
    vehicle: input.vehicle,
    destinationCity: input.destinationCity,
  })

  if (isSafety || (inlandSameCountry && !isFerry)) {
    const options = roadsideOptions(draftCtx, input.vehicle, input.destinationCity, input.tripResults)
    return {
      problem: isSafety
        ? "Red warning light — car stopped, driver is safe"
        : `Inland recovery needed — ${input.reference}`,
      currentLocation: location.label,
      deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: isSafety ? "safety" : "generic" }),
      happened: isSafety
        ? `Driver stopped the ${input.vehicle} on ${input.reference} after a red warning light. They are safe at a motorway service area. The car should not be driven further. Agent checked safety and location first; now ops chooses where to tow — no ferries on this inland route.`
        : `Order ${input.reference} is inland (${pickupCountry} → ${deliveryCountry}). Agent gathered facts; now choose recovery (tow). Baltic ferries are out of scope.`,
      summary: "What should we do? Choose recovery first — tow destination only.",
      stage: "recover",
      stageTitle: "Step 1 · Choose recovery",
      stagePrompt: "What should we do? Pick where the car is towed — dealer, workshop, or wait for dealer roadside. No ferry options on this inland breakdown.",
      facts: uniqFacts(input.facts),
      actions: input.actions,
      options,
      customerContact: "blocked",
      recommendationId: options.find((o) => o.kind === "recovery")?.id ?? options[0]?.id ?? "trip-tow-dealer",
    }
  }

  if (isFerry) {
    const promise = readDeliveryPromise(input.loaded)
    const options = ferryOptions(draftCtx, input.tripResults, {
      start: promise.start,
      zone: promise.zone,
    })
    // Tonight sold out → next Finnlines sailing + Travemünde hotel/rest (mandatory sea leg).
    const enforced = enforceDeFiFinnlinesOnly(options)
    const recommended =
      enforced.find((o) => o.id === "trip-finnlady")
      ?? enforced.find((o) => o.kind === "ferry_hotel")
      ?? enforced.find((o) => o.id === "trip-finnmaid")
      ?? enforced[0]
    return {
      problem: "Overnight ferry sold out — next Finnlines sailing + rest",
      currentLocation: location.label,
      deliveryTiming: buildDeliveryTiming({
        loaded: input.loaded,
        scenario: "ferry",
        recommended,
      }),
      happened: `Ferry risk on ${input.reference}: the planned overnight crossing is sold out. The Travemünde–Helsinki Finnlines leg is still required — driver rest hours block long extra driving, so the ferry cannot be skipped. Book the next Finnlines daily sailing (Finnstar / Finnmaid / Finnlady) and a Travemünde hotel when the gap is overnight.`,
      summary: "Choose the next Finnlines sailing (hotel/rest when needed).",
      stage: "travel",
      stageTitle: "Step 1 · Choose sailing",
      stagePrompt: "Tonight’s crossing is sold out — pick the next Finnlines ship. The sea leg is mandatory; prefer sailing + hotel/rest at Travemünde while the driver rests.",
      facts: uniqFacts(input.facts),
      actions: input.actions,
      options: enforced,
      customerContact: "blocked",
      recommendationId: recommended?.id ?? null,
    }
  }

  const options = roadsideOptions(draftCtx, input.vehicle, input.destinationCity, input.tripResults)
  return {
    problem: `Order ${input.reference} needs a person to decide`,
    currentLocation: location.label,
    deliveryTiming: buildDeliveryTiming({ loaded: input.loaded, scenario: "generic" }),
    happened: `Something on ${input.reference} needs a person. The agent gathered what it could from the records and the driver.`,
    summary: "What should we do?",
    stage: "recover",
    stageTitle: "Step 1 · Choose recovery",
    stagePrompt: "What should we do?",
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
    arrivalLabel: fallback.arrivalLabel ?? (typeof raw.arrivalLabel === "string" ? raw.arrivalLabel : null),
    opsNext: String(raw.opsNext ?? fallback.opsNext),
    implications: String(raw.implications ?? fallback.implications),
    requiresApproval: Array.isArray(raw.requiresApproval) ? raw.requiresApproval.map(String) : fallback.requiresApproval,
    kind: raw.kind ?? fallback.kind,
    lineName: raw.lineName ?? fallback.lineName,
    components: raw.components ?? fallback.components,
    // Prefer fallback draft (order/driver prefills) — LLM rarely returns structured bookingFields.
    bookingFields:
      fallback.bookingFields?.length && !bookingFieldsNeedPrefill(fallback.bookingFields)
        ? fallback.bookingFields
        : (raw.bookingFields ?? fallback.bookingFields),
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
    const stage = (parsed as Partial<AgentDecision>).stage ?? fallback.stage
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
      stage,
      stageTitle: (parsed as Partial<AgentDecision>).stageTitle ?? fallback.stageTitle,
      stagePrompt: (parsed as Partial<AgentDecision>).stagePrompt ?? fallback.stagePrompt,
    }
  } catch {
    return fallback
  }
}

function optionLooksLikeFerry(option: { kind?: string | null; lineName?: string | null; title?: string; id?: string }): boolean {
  if (option.kind === "ferry" || option.kind === "ferry_hotel") return true
  return /tallink|viking|finnlines|eckerö|eckero|ferry|sailing/i.test(`${option.lineName ?? ""} ${option.title ?? ""} ${option.id ?? ""}`)
}

/** True when a pending proposal still has Baltic ferry options on an inland same-country route. */
export function runHasInlandFerryMismatch(
  run: AgentRunRecord,
  route: { pickup?: string | null; delivery?: string | null },
): boolean {
  if (run.status !== "pending") return false
  const from = inferCountryCode(route.pickup ?? "")
  const to = inferCountryCode(route.delivery ?? "")
  const inland = Boolean(from && to && from === to)
  if (!inland) return false
  return run.decision.options.some(optionLooksLikeFerry)
}

/**
 * Pending decisions must declare recover vs travel staging.
 * Also catch recover-stage cards that still offer ferries (wrong lane).
 */
export function runNeedsStagingRefresh(run: AgentRunRecord): boolean {
  if (run.status !== "pending") return false
  const decision = run.decision
  if (!decision.stage || !decision.stageTitle || !decision.stagePrompt) return true
  const hasFerry = decision.options.some(optionLooksLikeFerry)
  const hasTow = decision.options.some((o) => o.kind === "recovery")
  if (decision.stage === "recover" && hasFerry) return true
  if (decision.stage === "travel" && hasTow && !hasFerry) return true
  return false
}

/** DE→FI travel options must be Finnlines ships, not Tallink/Viking as Travemünde→Helsinki. */
export function runNeedsFinnlinesRefresh(
  run: AgentRunRecord,
  route: { pickup?: string | null; delivery?: string | null },
): boolean {
  if (run.status !== "pending") return false
  const from = inferCountryCode(route.pickup ?? "")
  const to = inferCountryCode(route.delivery ?? "")
  const deToFi = from === "DE" && to === "FI"
  const looksDeFi = /leipzig|germany|travemunde|rostock/i.test(route.pickup ?? "")
    && /helsinki|finland|vuosaari/i.test(route.delivery ?? "")
  if (!deToFi && !looksDeFi) return false
  const options = run.decision.options
  if (!options.some(optionLooksLikeFerry)) return false
  const hasFinnShip = options.some((o) => /finnstar|finnmaid|finnlady/i.test(`${o.id} ${o.lineName} ${o.title}`))
  const hasWrongCorridor = options.some((o) =>
    /tallink|viking|eckerö|eckero|tallinn|path\s*[ab]|skip (the )?ferry|instead of (the )?ferry|detour around/i
      .test(`${o.id} ${o.lineName} ${o.title} ${o.summary}`),
  )
  const hasNonFinnFerry = options.some((o) =>
    (o.kind === "ferry" || o.kind === "ferry_hotel") && !isFinnlinesDeFiShip(o),
  )
  return !hasFinnShip || hasWrongCorridor || hasNonFinnFerry
}

/** True when a stored run is missing scannable fields, booking fields, or still has Finnish UI copy. */
export function runNeedsPriceTimeRefresh(run: AgentRunRecord): boolean {
  const decision = run.decision
  if (!decision.problem?.trim()) return true
  if (!decision.deliveryTiming?.promisedLabel || !decision.deliveryTiming?.expectedLabel) return true
  // Promised / now-expected should be dates only (no "13:00–15:00 EET").
  const timingBlob = `${decision.deliveryTiming.promisedLabel} ${decision.deliveryTiming.expectedLabel}`
  if (/\d{1,2}:\d{2}/.test(timingBlob) || /\b(?:EET|EEST|CET|CEST|UTC)\b/i.test(timingBlob)) return true
  if (decision.options.some((option) => typeof option.priceEur !== "number" || !option.timeLabel || !option.priceLabel)) return true
  if (decision.options.some((option) => (option.kind === "ferry_hotel" || option.kind === "ferry") && !(option.bookingFields?.length))) return true
  // Refresh blank booking fields → agent-prefilled draft era.
  if (decision.options.some((option) =>
    (option.kind === "ferry" || option.kind === "ferry_hotel" || option.kind === "recovery")
    && bookingFieldsNeedPrefill(option.bookingFields),
  )) return true
  // Refresh relative sailing/hotel wording ("tomorrow") → calendar dates.
  if (decision.options.some((option) => bookingDraftHasRelativeDates(option.bookingFields))) return true
  // Refresh when Now expected / delay chip disagree with recommended option arrival.
  if (decision.stage === "travel" || decision.options.some((o) => o.kind === "ferry" || o.kind === "ferry_hotel")) {
    const rec = decision.options.find((o) => o.id === decision.recommendationId) ?? decision.options[0]
    const expectedDay = decision.deliveryTiming?.expectedLabel?.replace(/^Now expected\s+/i, "").trim()
    if (rec?.arrivalLabel && expectedDay && !expectedDay.includes(rec.arrivalLabel)) return true
    // Old Finnlady: single "night before" or sail without multi-night hotel range.
    const hotel = rec?.bookingFields?.find((f) => f.key === "hotelNight")?.prefill ?? ""
    if (rec?.kind === "ferry_hotel" && hotel && !(/–|-/.test(hotel) && /\d+\s*nights?/i.test(hotel))) return true
  }
  if (decision.options.some((option) => option.id === "next-sailing" || option.id === "reroute-land" || option.id === "ferry-evening-hotel-a" || option.id === "ferry-morning-hotel-b")) return true
  if (decision.options.some((option) => (option.kind === "ferry_hotel" || option.kind === "ferry") && !option.lineName)) return true
  if (decision.options.some((option) => !(option.components?.length))) return true
  if (decision.options.some((option) => (option.kind === "ferry_hotel" || option.kind === "ferry" || option.kind === "recovery") && !option.bookUrl)) return true
  if (decision.options.some((option) => /NordSea Link|Baltic Gate|Silja Route Express/.test(option.lineName ?? ""))) return true
  // Refresh when catalog time labels / copy were shortened for the judge layout.
  if (decision.options.some((option) => /Dep ~|tow ETA|does not purchase|agent never books|adac\.de\/reise-freizeit|vikingline\.com\/?$/i.test(`${option.timeLabel} ${option.summary} ${option.bookUrl}`))) return true
  // Stale inland roadside runs that wrongly proposed Baltic ferries.
  if (
    /red warning|roadside|cannot be driven|safety/i.test(`${decision.problem} ${decision.happened}`)
    && decision.options.some(optionLooksLikeFerry)
  ) return true
  // Stale DE→FI runs that still offer a land/skip-ferry substitute.
  if (decision.options.some((option) =>
    /tallinn|eckerö|eckero|path\s*[ab]|skip (the )?ferry|instead of (the )?ferry|detour around|drive \+ tallinn/i
      .test(`${option.id} ${option.lineName} ${option.title} ${option.summary}`),
  )) return true
  const blob = [
    decision.problem,
    decision.summary,
    decision.stagePrompt,
    ...decision.options.flatMap((option) => [option.title, option.timeLabel, option.delayLabel, option.opsNext]),
  ].join(" ")
  return /[äöÄÖ]|Hinaus|Toimitus|varoitus|Lautt|pisteelle|korjaamo|Hyväksy|Valitse|Choose a path|Path [AB]\b/i.test(blob)
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
      content: `Work order ${loaded.order.reference} (${orderId}). Pickup ${loaded.pickup ? `${loaded.pickup.city}, ${loaded.pickup.country}` : "unknown"} → delivery ${loaded.delivery ? `${loaded.delivery.city}, ${loaded.delivery.country}` : "unknown"}. Gather facts with tools, then reply with JSON only.
If both ends are in the same country with no sea leg (e.g. DE→DE), call search_trips with prefer=tow and propose tow/recovery only — never Tallink/Viking/Finnlines.
For Baltic ferry / sailing cases (DE/SE → FI/EE or FERRY_* alert) call search_trips with prefer=ferry before proposing options. Copy bookUrl and lineName from tool results only — never invent URLs. Do not book.
{"problem":"...","happened":"...","summary":"What should we do?","stage":"recover|travel","stageTitle":"Step 1 · Choose recovery|Step 1 · Choose sailing","stagePrompt":"...","recommendationId":"option-id","options":[{"id":"trip-tow-dealer","lineName":"Roadside assistance","title":"...","kind":"recovery","priceEur":380,"priceLabel":"€380","timeLabel":"Tow ~4 h","delayLabel":"...","bookUrl":"https://www.adac.de/hilfe/","components":[{"label":"Tow truck","priceLabel":"€310","timeLabel":"4 h ETA"}],"opsNext":"...","implications":"...","requiresApproval":["book_tow"]}]}
Include a short English "problem" line. Set stage/stageTitle/stagePrompt: roadside → recover ("Step 1 · Choose recovery"); ferry capacity → travel ("Step 1 · Choose sailing"). Propose 2–4 options. Every option MUST include priceEur, priceLabel, timeLabel, delayLabel, bookUrl, and components[]. Price and time are primary. Write ops-facing English. Do not contact the customer.`,
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
    let decision = parseDecisionFromText(result.content ?? "", fallback)
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
          kind: option.kind ?? (hit.kind === "tow" ? "recovery" : hit.kind === "ferry_hotel" ? "ferry_hotel" : hit.kind === "ferry" ? "ferry" : option.kind),
        }
      })
    }
    // Hard guard: inland same-country / SAFETY_STOP must not keep Baltic ferry options.
    const pickupBlob = loaded.pickup ? `${loaded.pickup.city}, ${loaded.pickup.country}` : ""
    const deliveryBlob = loaded.delivery ? `${loaded.delivery.city}, ${loaded.delivery.country}` : ""
    const inland = (() => {
      const a = inferCountryCode(pickupBlob)
      const b = inferCountryCode(deliveryBlob)
      return Boolean(a && b && a === b)
    })()
    const safety = (open?.signal === "SAFETY_STOP") || ctx.facts.some((f) => f.label === "SAFETY_STOP")
    const ferryOpts = decision.options.filter((o) => o.kind === "ferry" || o.kind === "ferry_hotel" || /tallink|viking|finnlines|eckerö|eckero/i.test(`${o.lineName} ${o.title}`))
    if ((inland || safety) && ferryOpts.length > 0) {
      decision = {
        ...fallback,
        facts: uniqFacts(ctx.facts),
        actions: ctx.actions,
        currentLocation: decision.currentLocation ?? fallback.currentLocation,
        deliveryTiming: decision.deliveryTiming ?? fallback.deliveryTiming,
      }
    }
    // DE→FI: Finnlines sea leg mandatory — strip land/skip-ferry substitutes from model output.
    const deToFi = inferCountryCode(pickupBlob) === "DE" && inferCountryCode(deliveryBlob) === "FI"
    if (deToFi && decision.stage === "travel") {
      decision.options = enforceDeFiFinnlinesOnly(decision.options)
      if (!decision.options.some((o) => o.id === decision.recommendationId)) {
        decision.recommendationId =
          decision.options.find((o) => o.kind === "ferry_hotel")?.id
          ?? decision.options[0]?.id
          ?? decision.recommendationId
      }
      if (!/Finnlines is required|rest hours/i.test(decision.stagePrompt ?? "")) {
        decision.stagePrompt = `${decision.stagePrompt ?? "Choose a Finnlines sailing."} ${DE_FI_FERRY_REST_NOTE}`
      }
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
