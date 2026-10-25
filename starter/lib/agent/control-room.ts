import "server-only"

import { buildBoardCard } from "@/lib/present/board"
import { rows, str } from "@/lib/present/bundle"
import { loadBoardBundles, loadOrder } from "@/lib/present/load"
import { relativeTo } from "@/lib/present/time"
import type { Tone } from "@/lib/present/types"
import { resolveCurrentLocation } from "./current-location"
import { resolveDeliveryStage } from "./delivery-stage"
import { resolveDeliveryTimeline } from "./delivery-timeline"
import { buildDriverChat } from "./driver-chat"
import {
  agentMode,
  runHasInlandFerryMismatch,
  runNeedsFinnlinesRefresh,
  runNeedsPriceTimeRefresh,
  runNeedsStagingRefresh,
  runOnTheRoadAgent,
} from "./on-the-road/loop"
import { ensureAttentionAgentRuns, getWorkingActions, isAgentWorking } from "./precompute"
import { latestRunForOrder, runsByOrderIds } from "./store"
import type { AgentRunRecord, QueueItem } from "./types"
import { computeSlackHours, scoreUrgency, urgencyRank } from "./urgency"

/** Short in-memory cache so rapid reloads / Approve refresh don't re-scan the board. */
let queueCache: { at: number; body: Awaited<ReturnType<typeof buildAttentionQueueUncached>> } | null = null
const QUEUE_CACHE_MS = 2500

const ON_ROAD_SIGNALS = new Set([
  "SAFETY_STOP",
  "FERRY_SOLD_OUT",
  "FERRY_CONNECTION_RISK",
  "TRACKING_GAP",
  "DELAY_RISK",
])

function alertSignalFromShort(short: string | null): string | null {
  if (!short) return null
  const upper = short.toUpperCase()
  for (const signal of ON_ROAD_SIGNALS) {
    if (upper.includes(signal.replaceAll("_", " ")) || upper.includes(signal)) return signal
  }
  if (/warning|safe stop|stopped/i.test(short)) return "SAFETY_STOP"
  if (/promise.*unachiev|unachiev.*promise/i.test(short)) return "DELIVERY_PROMISE_UNACHIEVABLE"
  if (/delivery access/i.test(short)) return "DELIVERY_ACCESS_RISK"
  if (/tracking|no .*position|driver-app position/i.test(short)) return "TRACKING_GAP"
  if (/empty pickup/i.test(short)) return "EMPTY_PICKUP"
  if (/condition claim|post-delivery condition/i.test(short)) return "CONDITION_CLAIM"
  if (/proof/i.test(short)) return "PROOF_REVIEW"
  if (/site access conflict/i.test(short)) return "SITE_ACCESS_CONFLICT"
  if (/site access|unconfirmed/i.test(short)) return "SITE_ACCESS_UNCONFIRMED"
  if (/release document|release unclear/i.test(short)) return "RELEASE_DOCUMENT_UNCLEAR"
  if (/positioning/i.test(short)) return "POSITIONING_AT_RISK"
  if (/driver.*(avail|illness|risk)/i.test(short)) return "DRIVER_AVAILABILITY_RISK"
  if (/invoice/i.test(short)) return "INVOICE_REFERENCE_QUERY"
  if (/import travel|travel decision|fr_import/i.test(short)) return "FR_IMPORT_TRAVEL_DECISION"
  if (/ferry/i.test(short)) return "FERRY"
  if (/incident/i.test(short)) return "INCIDENT"
  if (/support inbox|open thread|conversation/i.test(short)) return "OPEN_THREAD"
  // Prefer a known raw CODE_LIKE token if present.
  const code = short.match(/\b[A-Z][A-Z0-9_]{4,}\b/)?.[0]
  return code ?? null
}

/** Short queue chip — never truncate mid-word like UNACHIEVABL. */
export function formatSignalLabel(signal: string | null): string | null {
  if (!signal) return null
  const key = signal.toUpperCase().replaceAll(" ", "_")
  const labels: Record<string, string> = {
    SAFETY_STOP: "Safety stop",
    TRACKING_GAP: "Tracking gap",
    FERRY_SOLD_OUT: "Ferry sold out",
    FERRY_CONNECTION_RISK: "Ferry cutoff",
    FERRY: "Ferry",
    DELAY_RISK: "Delay risk",
    DELIVERY_PROMISE_UNACHIEVABLE: "Promise at risk",
    DELIVERY_ACCESS_RISK: "Access risk",
    CONDITION_CLAIM: "Condition claim",
    CONDITION_CLAIM_REVIEW: "Condition review",
    EMPTY_PICKUP: "Empty pickup",
    PROOF_REVIEW: "Proof review",
    INCIDENT: "Incident",
    POSITIONING_AT_RISK: "Positioning",
    RELEASE_DOCUMENT_UNCLEAR: "Release unclear",
    SITE_ACCESS_CONFLICT: "Site access",
    SITE_ACCESS_UNCONFIRMED: "Site unconfirmed",
    DRIVER_AVAILABILITY_RISK: "Driver risk",
    FR_IMPORT_TRAVEL_DECISION: "Travel decision",
    INVOICE_REFERENCE_QUERY: "Invoice query",
    PICKUP_PROOF_REJECTED: "Pickup proof",
    OPEN_THREAD: "Open thread",
  }
  if (labels[key]) return labels[key]
  const cleaned = signal
    .replaceAll("_", " ")
    .replace(/\bunachievable\b/i, "at risk")
    .replace(/\bconnection risk\b/i, "cutoff")
    .trim()
  // Keep chips short; reason line already carries the detail.
  return cleaned.length > 22 ? `${cleaned.slice(0, 20).trim()}…` : cleaned
}

function agentStatusFromRun(
  run: AgentRunRecord | undefined,
  orderId: string,
): QueueItem["agentStatus"] {
  if (isAgentWorking(orderId)) return "working"
  if (!run) return "idle"
  if (run.status === "approved") return "approved"
  if (run.status === "changed") return "changed"
  if (run.status === "pending") return "pending"
  return "ready"
}

function isDecided(status: QueueItem["agentStatus"]): boolean {
  return status === "approved" || status === "changed"
}

function slackFromBundle(bundle: Parameters<typeof resolveDeliveryStage>[0], snapshotAt: string | null): number | null {
  const windows = rows(bundle, "time_windows")
  let promiseStart: string | null = null
  let promiseEnd: string | null = null
  let pickupClose: string | null = null
  for (const row of windows) {
    const purpose = str(row.details.purpose)
    if (purpose === "CUSTOMER_DELIVERY_PROMISE") {
      promiseStart = str(row.details.start_at) ?? promiseStart
      promiseEnd = str(row.details.end_at) ?? promiseEnd
    }
    if (purpose === "SELECTED_PICKUP_SLOT" || purpose === "PICKUP_AVAILABILITY") {
      pickupClose = str(row.details.end_at) ?? pickupClose
    }
  }
  return computeSlackHours({ snapshotAt, promiseStart, promiseEnd, pickupClose })
}

async function buildAttentionQueueUncached(): Promise<{
  snapshotAt: string | null
  mode: "mock" | "llm"
  items: QueueItem[]
  handled: QueueItem[]
  precomputing: number
}> {
  const { snapshotAt, bundles } = await loadBoardBundles()
  const bundleById = new Map(bundles.map((bundle) => [bundle.order.id, bundle]))
  const cards = bundles.map(buildBoardCard).filter((card) => card.attention.length > 0)
  const orderIds = cards.map((card) => card.id)

  // Seed every attention case (incl. P3). Mock waits; LLM continues in background.
  await ensureAttentionAgentRuns(orderIds, { wait: agentMode() === "mock" })

  const runs = await runsByOrderIds(orderIds)
  const precomputing = orderIds.filter((id) => isAgentWorking(id)).length

  const all: QueueItem[] = cards.map((card) => {
    const top = card.attention[0]
    const run = runs.get(card.id)
    const bundle = bundleById.get(card.id)!
    const stage = resolveDeliveryStage(bundle)
    const alertItem = card.attention.find((item) => item.kind === "alert" || item.kind === "owned_alert" || item.kind === "incident")
    const rawSignal = alertSignalFromShort(alertItem?.short ?? top?.short ?? null)
    const signal = formatSignalLabel(rawSignal)
    const waiting = top?.at ? relativeTo(top.at, snapshotAt)?.text : (top?.atLabel ?? null)
    const slackHours = slackFromBundle(bundle, snapshotAt)
    const scored = scoreUrgency({
      signal: rawSignal,
      reasonTitle: top?.title,
      reasonShort: top?.short,
      reference: card.reference,
      attentionTone: top?.tone ?? card.attentionTone,
      slackHours,
    })
    return {
      orderId: card.id,
      reference: card.reference,
      vehicle: card.vehicle,
      customer: card.customer,
      route: `${card.from.city} → ${card.to.city}`,
      reason: top?.title ?? "Needs a person",
      reasonTone: (top?.tone ?? card.attentionTone) as Tone & QueueItem["reasonTone"],
      waitingLabel: waiting || "Open",
      agentStatus: agentStatusFromRun(run, card.id),
      signal,
      attentionShort: top?.short ?? "Needs person",
      urgency: scored.tier,
      urgencyLabel: scored.title,
      urgencyClass: scored.class,
      urgencyReason: scored.reason,
      urgencyShortReason: scored.shortReason,
      safetyFlag: scored.safetyFlag,
      slackHours: scored.slackHours,
      raisedAt: top?.at ?? null,
      deliveryStage: stage.short,
      deliveryStageKnown: stage.known,
    }
  })

  // P1 → P2 → P3; least slack first; oldest raisedAt on ties.
  const sortQueue = (list: QueueItem[]) => [...list].sort((a, b) => {
    const slackA = a.slackHours ?? Number.POSITIVE_INFINITY
    const slackB = b.slackHours ?? Number.POSITIVE_INFINITY
    const raisedA = a.raisedAt ? Date.parse(a.raisedAt) : Number.POSITIVE_INFINITY
    const raisedB = b.raisedAt ? Date.parse(b.raisedAt) : Number.POSITIVE_INFINITY
    return (
      urgencyRank(a.urgencyClass) - urgencyRank(b.urgencyClass)
      || slackA - slackB
      || raisedA - raisedB
      || a.reference.localeCompare(b.reference)
    )
  })

  // Active queue = still needs a person. Approved / changed leave the list.
  const items = sortQueue(all.filter((item) => !isDecided(item.agentStatus)))
  const handled = sortQueue(all.filter((item) => isDecided(item.agentStatus)))

  return { snapshotAt, mode: agentMode(), items, handled, precomputing }
}

/** Attention queue — seeds missing agent runs (mock awaits; results cached in agent_runs). */
export async function buildAttentionQueue(): Promise<{
  snapshotAt: string | null
  mode: "mock" | "llm"
  items: QueueItem[]
  handled: QueueItem[]
  precomputing: number
}> {
  const now = Date.now()
  if (queueCache && now - queueCache.at < QUEUE_CACHE_MS) return queueCache.body
  const body = await buildAttentionQueueUncached()
  queueCache = { at: now, body }
  return body
}

/** Drop queue cache after Approve / Change / agent run so the list updates immediately. */
export function invalidateAttentionQueueCache(): void {
  queueCache = null
}

export async function buildDecisionCard(orderId: string, opts?: { ensureAgent?: boolean; refreshStale?: boolean }) {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null

  let run = await latestRunForOrder(orderId)
  const card = buildBoardCard(loaded.bundle)
  const onRoad = loaded.alerts.some((a) => ON_ROAD_SIGNALS.has(a.signal) && (a.status === "OPEN" || a.status === "ACKNOWLEDGED"))
  const pickup = loaded.pickup ? `${loaded.pickup.city}, ${loaded.pickup.country}` : null
  const delivery = loaded.delivery ? `${loaded.delivery.city}, ${loaded.delivery.country}` : null
  let refreshedStale = false
  const agentWorking = isAgentWorking(orderId)

  // Discard pending ferry proposals on inland same-country routes, re-stage, or replace wrong DE→FI carriers.
  if (
    (opts?.refreshStale !== false)
    && run
    && run.status === "pending"
    && !agentWorking
    && (
      runHasInlandFerryMismatch(run, { pickup, delivery })
      || runNeedsStagingRefresh(run)
      || runNeedsFinnlinesRefresh(run, { pickup, delivery })
      || runNeedsPriceTimeRefresh(run)
    )
  ) {
    run = await runOnTheRoadAgent(orderId)
    refreshedStale = true
    invalidateAttentionQueueCache()
  }

  // Prefer background precompute; only seed here when explicitly asked and nothing is in flight.
  if (opts?.ensureAgent && !run && !agentWorking && (onRoad || card.attention.length > 0)) {
    run = await runOnTheRoadAgent(orderId)
  }

  const currentLocation = resolveCurrentLocation(loaded, run)
  const deliveryStage = resolveDeliveryStage(loaded.bundle)
  const deliveryTimeline = resolveDeliveryTimeline(loaded, run)
  const driverChat = buildDriverChat(loaded, run)
  const topAttention = card.attention[0]
  const openAlert = loaded.alerts.find((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
  const slackHours = slackFromBundle(loaded.bundle, loaded.bundle.snapshotAt ?? null)
  const urgency = scoreUrgency({
    signal: openAlert?.signal ?? alertSignalFromShort(topAttention?.short ?? null),
    reasonTitle: topAttention?.title,
    reasonShort: topAttention?.short,
    reference: card.reference,
    attentionTone: topAttention?.tone ?? card.attentionTone,
    slackHours,
  })

  return {
    orderId,
    reference: loaded.order.reference,
    vehicle: card.vehicle,
    customer: card.customer,
    route: `${card.from.city} → ${card.to.city}`,
    lane: card.displayLane,
    attention: card.attention,
    alerts: loaded.alerts.map((a) => ({
      id: a.id,
      signal: a.signal,
      severity: a.severity,
      status: a.status,
      summary: a.summary,
    })),
    onRoad,
    mode: agentMode(),
    /** Where the car is now — under Problem on the decision card. */
    currentLocation,
    /** Where the car is in the delivery process (lane / plan / travel) — not GPS. */
    deliveryStage,
    /** Dated pickup → drive/ferry → must-deliver / now-expected story (journey folded in). */
    deliveryTimeline,
    /** Driver ↔ Ops/Agent thread — never the paying customer. */
    driverChat,
    /** Same P1/P2/P3 class as the queue chip. */
    urgencyClass: urgency.class,
    urgencyLabel: urgency.title,
    urgencyReason: urgency.reason,
    urgencyShortReason: urgency.shortReason,
    safetyFlag: urgency.safetyFlag,
    slackHours: urgency.slackHours,
    /** True when a background run is still writing this order’s proposal. */
    agentWorking,
    /** Live tool-call hints while agentWorking (empty once the run is stored). */
    workingActions: agentWorking ? getWorkingActions(orderId) : [],
    /** True when this response replaced a stale inland-ferry proposal. */
    refreshedStale,
    run,
  }
}
