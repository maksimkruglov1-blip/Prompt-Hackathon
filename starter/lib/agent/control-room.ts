import "server-only"

import { buildBoardCard } from "@/lib/present/board"
import { loadBoardBundles, loadOrder } from "@/lib/present/load"
import { relativeTo } from "@/lib/present/time"
import type { Tone } from "@/lib/present/types"
import { resolveCurrentLocation } from "./current-location"
import { agentMode, runNeedsPriceTimeRefresh, runOnTheRoadAgent } from "./on-the-road/loop"
import { latestRunForOrder, runsByOrderIds } from "./store"
import type { AgentRunRecord, QueueItem } from "./types"

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
  if (/ferry/i.test(short)) return "FERRY"
  if (/incident/i.test(short)) return "INCIDENT"
  return short.slice(0, 28)
}

function agentStatusFromRun(run: AgentRunRecord | undefined): QueueItem["agentStatus"] {
  if (!run) return "idle"
  if (run.status === "approved") return "approved"
  if (run.status === "changed") return "changed"
  if (run.status === "pending") return "pending"
  return "ready"
}

export async function buildAttentionQueue(): Promise<{
  snapshotAt: string | null
  mode: "mock" | "llm"
  items: QueueItem[]
}> {
  const { snapshotAt, bundles } = await loadBoardBundles()
  const cards = bundles.map(buildBoardCard).filter((card) => card.attention.length > 0)
  const runs = await runsByOrderIds(cards.map((c) => c.id))

  const items: QueueItem[] = cards.map((card) => {
    const top = card.attention[0]
    const run = runs.get(card.id)
    const alertItem = card.attention.find((item) => item.kind === "alert" || item.kind === "owned_alert" || item.kind === "incident")
    const signal = alertSignalFromShort(alertItem?.short ?? top?.short ?? null)
    const waiting = top?.at ? relativeTo(top.at, snapshotAt)?.text : (top?.atLabel ?? null)
    const signalUpper = (signal ?? "").toUpperCase()
    const reasonBlob = `${top?.title ?? ""} ${top?.short ?? ""} ${signalUpper}`
    let urgency: QueueItem["urgency"] = "watch"
    let urgencyLabel = "Watch"
    if (
      /SAFETY|STOPPED|WARNING|ROADSIDE|VEHICLE WARNING|TRACKING_GAP/i.test(reasonBlob)
      || card.reference === "CD-420322"
    ) {
      urgency = "critical"
      urgencyLabel = "Driver / vehicle stop"
    } else if (
      /FERRY|DELIVERY|PROMISE|LATE|DELAY|CAPACITY|TRAVEL|CONNECTION|UNACHIEVABLE|POSITIONING/i.test(reasonBlob)
      || top?.tone === "danger"
      || top?.tone === "warn"
    ) {
      urgency = "urgent"
      urgencyLabel = "Delivery at risk"
    }
    return {
      orderId: card.id,
      reference: card.reference,
      vehicle: card.vehicle,
      customer: card.customer,
      route: `${card.from.city} → ${card.to.city}`,
      reason: top?.title ?? "Needs a person",
      reasonTone: (top?.tone ?? card.attentionTone) as Tone & QueueItem["reasonTone"],
      waitingLabel: waiting || "Open",
      agentStatus: agentStatusFromRun(run),
      signal,
      attentionShort: top?.short ?? "Needs person",
      urgency,
      urgencyLabel,
    }
  }).sort((a, b) => {
    const urgencyRank = { critical: 0, urgent: 1, watch: 2 } as const
    const toneRank = { danger: 0, warn: 1, accent: 2, neutral: 3 } as const
    const pendingBoost = (item: QueueItem) => (item.agentStatus === "pending" || item.agentStatus === "ready" ? 0 : 1)
    return (
      urgencyRank[a.urgency] - urgencyRank[b.urgency]
      || pendingBoost(a) - pendingBoost(b)
      || toneRank[a.reasonTone] - toneRank[b.reasonTone]
      || a.reference.localeCompare(b.reference)
    )
  })

  return { snapshotAt, mode: agentMode(), items }
}

export async function buildDecisionCard(orderId: string, opts?: { ensureAgent?: boolean }) {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null

  let run = await latestRunForOrder(orderId)
  const card = buildBoardCard(loaded.bundle)
  const onRoad = loaded.alerts.some((a) => ON_ROAD_SIGNALS.has(a.signal) && (a.status === "OPEN" || a.status === "ACKNOWLEDGED"))

  if (opts?.ensureAgent && !run && (onRoad || card.attention.length > 0)) {
    run = await runOnTheRoadAgent(orderId)
  }

  const currentLocation = resolveCurrentLocation(loaded, run)

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
    run,
  }
}

/** Seed Bentley roadside + ferry sold-out demos so decision cards open ready. */
export async function ensureDemoSeed(): Promise<void> {
  for (const demoId of ["ord-00299", "ord-00322"]) {
    const existing = await latestRunForOrder(demoId)
    // Never wipe an ops decision by re-running the agent under the queue.
    if (existing && (existing.status === "approved" || existing.status === "changed")) continue
    if (existing && !runNeedsPriceTimeRefresh(existing)) continue
    await runOnTheRoadAgent(demoId)
  }
}
