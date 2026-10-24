import "server-only"

import { loadOrder } from "@/lib/present/load"
import { str } from "@/lib/present/bundle"
import type { AgentAction, AgentFact } from "../types"

export type ToolContext = {
  orderId: string
  now: string
  actions: AgentAction[]
  facts: AgentFact[]
}

export type ToolResult = { ok: true; output: string; facts?: AgentFact[] } | { ok: false; error: string }

function pushAction(ctx: ToolContext, tool: string, summary: string, detail?: string) {
  ctx.actions.push({ tool, summary, at: ctx.now, detail: detail ?? null })
}

/** Cheap work first: ask the driver (mock). Never contacts the paying customer. */
export async function askDriver(ctx: ToolContext, question: string): Promise<ToolResult> {
  const loaded = await loadOrder(ctx.orderId)
  if (!loaded) return { ok: false, error: "Order not found" }

  const driver = loaded.drivers[0]
  const driverName = driver?.displayName ?? "the driver"
  const alertSignals = loaded.alerts.map((a) => a.signal)
  const isSafety = alertSignals.includes("SAFETY_STOP")
  const isFerry = alertSignals.some((s) => s.includes("FERRY"))

  let reply: string
  if (isSafety) {
    const q = question.toLowerCase()
    if (q.includes("safe") || q.includes("safety") || q.includes("turvall")) {
      reply = `${driverName}: Yes — I'm in a service-area car park, engine off, hazard lights on. Nobody injured.`
    } else if (q.includes("photo") || q.includes("dashboard") || q.includes("light")) {
      reply = `${driverName}: Dashboard photo sent. Red warning triangle with a car silhouette; power feels limited when accelerating.`
    } else if (q.includes("location") || q.includes("where") || q.includes("sijaint")) {
      reply = `${driverName}: A9 northbound service area near Ingolstadt. I can wait here.`
    } else {
      reply = `${driverName}: Still stopped safely. Car should not be driven. Waiting for recovery instructions.`
    }
  } else if (isFerry) {
    reply = `${driverName}: I'm at the terminal check-in. The sailing I was booked on is full / at risk. I need a new plan before the customer promise slips.`
  } else {
    reply = `${driverName}: On site and reachable. ${question.slice(0, 120)} — answered from the mock driver.`
  }

  pushAction(ctx, "ask_driver", `Asked driver: ${question.slice(0, 80)}`, reply)
  const facts: AgentFact[] = [
    { label: "Driver reply", value: reply, source: "Mock driver chat", sourceKind: "driver" },
  ]
  ctx.facts.push(...facts)
  return { ok: true, output: reply, facts }
}

export async function lookupOrder(ctx: ToolContext): Promise<ToolResult> {
  const loaded = await loadOrder(ctx.orderId)
  if (!loaded) return { ok: false, error: "Order not found" }
  const vehicle = loaded.items[0]?.vehicle
  const vehicleLabel = vehicle ? `${vehicle.make} ${vehicle.model}` : "Unknown vehicle"
  const customer = loaded.customer?.name ?? "Unknown customer"
  const origin = loaded.pickup ? `${loaded.pickup.city}, ${loaded.pickup.country}` : "Unknown origin"
  const destination = loaded.delivery ? `${loaded.delivery.city}, ${loaded.delivery.country}` : "Unknown destination"
  const driver = loaded.drivers[0]?.displayName ?? "Unassigned"

  const openAlerts = loaded.alerts.filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
  const summary = [
    `Order ${loaded.order.reference} (${loaded.order.status}).`,
    `Vehicle: ${vehicleLabel}.`,
    `Customer (paying): ${customer} — agent must NOT contact.`,
    `Route: ${origin} → ${destination}.`,
    `Driver: ${driver}.`,
    `Open alerts: ${openAlerts.map((a) => `${a.signal}: ${a.summary}`).join(" | ") || "none"}.`,
  ].join(" ")

  const facts: AgentFact[] = [
    { label: "Order", value: loaded.order.reference, source: "orders", sourceKind: "order" },
    { label: "Vehicle", value: vehicleLabel, source: "vehicles", sourceKind: "vehicle" },
    { label: "Customer", value: customer, source: "customers (do not contact)", sourceKind: "order" },
    { label: "Route", value: `${origin} → ${destination}`, source: "addresses", sourceKind: "site" },
    { label: "Driver", value: driver, source: "drivers", sourceKind: "driver" },
    ...openAlerts.map((a) => ({
      label: a.signal,
      value: a.summary,
      source: `alert ${a.id}`,
      sourceKind: "alert" as const,
    })),
  ]
  ctx.facts.push(...facts)
  pushAction(ctx, "lookup_order", `Looked up ${loaded.order.reference}`, summary)
  return { ok: true, output: summary, facts }
}

export async function gatherFacts(ctx: ToolContext): Promise<ToolResult> {
  const loaded = await loadOrder(ctx.orderId)
  if (!loaded) return { ok: false, error: "Order not found" }

  const messages = loaded.messages
    .filter((m) => m.authorType === "driver" || m.authorType === "operator")
    .sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime())
    .slice(-6)

  const lines = messages.map((m) => {
    const who = m.authorType
    const body = m.body.slice(0, 200)
    return `[${m.authoredAt.toISOString()}] ${who}: ${body}`
  })

  const facts: AgentFact[] = messages.map((m) => ({
    label: m.authorType === "driver" ? "Driver message" : "Ops message",
    value: m.body,
    source: `message ${m.id}`,
    sourceKind: "message" as const,
  }))

  // Delivery promise from related time windows if present
  const windows = loaded.related.time_windows ?? []
  for (const window of windows) {
    const purpose = str(window.details.purpose)
    if (purpose === "CUSTOMER_DELIVERY_PROMISE") {
      const start = str(window.details.start_at)
      const end = str(window.details.end_at)
      if (start) {
        facts.push({
          label: "Delivery promise",
          value: end ? `${start} → ${end}` : start,
          source: `time_windows ${window.id}`,
          sourceKind: "order",
        })
      }
    }
  }

  ctx.facts.push(...facts)
  const output = lines.length ? lines.join("\n") : "No recent driver/ops messages on this order."
  pushAction(ctx, "gather_facts", "Gathered conversation and promise facts", output.slice(0, 400))
  return { ok: true, output, facts }
}

/** Mock roadside recovery estimates — never books without approval. */
export async function estimateRecovery(ctx: ToolContext, destination: "dealer" | "workshop"): Promise<ToolResult> {
  const loaded = await loadOrder(ctx.orderId)
  if (!loaded) return { ok: false, error: "Order not found" }
  const city = loaded.delivery?.city ?? "destination"
  const estimate = destination === "dealer"
    ? { etaHours: 4, costEur: 380, place: `${city} dealer / receiving site`, delay: "Delivery slips to tomorrow evening" }
    : { etaHours: 2.5, costEur: 290, place: "Independent workshop near Ingolstadt", delay: "Delivery paused until workshop clears the car (1–2 days)" }

  const output = `Tow to ${estimate.place}: ~${estimate.etaHours} h, ~€${estimate.costEur}. ${estimate.delay}. Quote only — not booked.`
  const facts: AgentFact[] = [
    {
      label: destination === "dealer" ? "Tow quote → dealer" : "Tow quote → workshop",
      value: output,
      source: "Mock roadside pricing",
      sourceKind: "tool",
    },
  ]
  ctx.facts.push(...facts)
  pushAction(ctx, "estimate_recovery", `Estimated tow to ${destination}`, output)
  return { ok: true, output, facts }
}

export const TOOL_DEFINITIONS = [
  {
    name: "ask_driver",
    description: "Send a short question to the assigned driver (mock). Use for safety, location, symptoms. Never use this to reach the paying customer.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  {
    name: "lookup_order",
    description: "Load order, vehicle, customer, route, driver and open alerts.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "gather_facts",
    description: "Collect recent driver/ops messages and the delivery promise.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "estimate_recovery",
    description: "Get a mock tow quote to dealer or workshop. Does not book.",
    parameters: {
      type: "object",
      properties: { destination: { type: "string", enum: ["dealer", "workshop"] } },
      required: ["destination"],
    },
  },
] as const

export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === "contact_customer" || name === "message_customer" || name === "call_customer") {
    pushAction(ctx, name, "Blocked: agent must not contact the paying customer")
    return { ok: false, error: "Blocked: never contact the paying customer. Bring a person a decision instead." }
  }
  if (name === "ask_driver") return askDriver(ctx, String(args.question ?? ""))
  if (name === "lookup_order") return lookupOrder(ctx)
  if (name === "gather_facts") return gatherFacts(ctx)
  if (name === "estimate_recovery") {
    const dest = args.destination === "workshop" ? "workshop" : "dealer"
    return estimateRecovery(ctx, dest)
  }
  if (name === "book_tow" || name === "change_promise" || name === "send_customer_message") {
    pushAction(ctx, name, "Blocked until human approval")
    return { ok: false, error: "Requires human approval before booking, cost, date change or customer message." }
  }
  return { ok: false, error: `Unknown tool: ${name}` }
}
