/**
 * Background on-the-road runs for every attention case.
 * Mock path is cheap — seed all missing proposals up front and cache in agent_runs.
 */

import "server-only"

import { agentMode, runOnTheRoadAgent } from "./on-the-road/loop"
import { runsByOrderIds } from "./store"
import type { AgentAction, AgentRunRecord } from "./types"

const inflight = new Map<string, Promise<AgentRunRecord | null>>()

/** Live tool-call hints while a background run is in flight (card shows these, not an empty wait). */
const workingActions = new Map<string, AgentAction[]>()

const SEED_ACTIONS: Omit<AgentAction, "at">[] = [
  { tool: "lookup_order", summary: "Reading order, alerts, and delivery promise" },
  { tool: "ask_driver", summary: "Checking driver messages and location" },
  { tool: "search_trips", summary: "Searching recovery / ferry options" },
]

export function isAgentWorking(orderId: string): boolean {
  return inflight.has(orderId)
}

export function agentWorkingOrderIds(): string[] {
  return [...inflight.keys()]
}

/** Tool calls shown on the card while a background run is still writing. */
export function getWorkingActions(orderId: string): AgentAction[] {
  return workingActions.get(orderId) ?? []
}

function markWorking(orderId: string): void {
  const at = new Date().toISOString()
  workingActions.set(
    orderId,
    SEED_ACTIONS.map((action) => ({ ...action, at })),
  )
}

async function runOne(orderId: string): Promise<AgentRunRecord | null> {
  try {
    return await runOnTheRoadAgent(orderId)
  } catch (error) {
    console.error("background agent run failed", orderId, error)
    return null
  } finally {
    inflight.delete(orderId)
    workingActions.delete(orderId)
  }
}

/** Run up to `limit` tasks at a time. */
async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(workers)
}

function needsProposal(run: AgentRunRecord | undefined): boolean {
  if (!run) return true
  // Decided rows keep their history; pending proposals are already done.
  if (run.status === "pending" || run.status === "approved" || run.status === "changed") return false
  return true
}

/**
 * Ensure every attention order has a stored agent proposal.
 * - mock: await concurrent runs (fast) so the first queue paint is decision-ready
 * - llm: kick background runs without blocking the queue response
 */
export async function ensureAttentionAgentRuns(
  orderIds: string[],
  opts?: { wait?: boolean },
): Promise<void> {
  if (orderIds.length === 0) return
  const existing = await runsByOrderIds(orderIds)
  const missing = orderIds.filter((id) => needsProposal(existing.get(id)) && !inflight.has(id))
  if (missing.length === 0) return

  const mode = agentMode()
  const wait = opts?.wait ?? mode === "mock"
  const concurrency = mode === "mock" ? 10 : 3

  const start = async (orderId: string) => {
    if (inflight.has(orderId)) return inflight.get(orderId)!
    markWorking(orderId)
    const promise = runOne(orderId)
    inflight.set(orderId, promise)
    return promise
  }

  if (!wait) {
    for (const orderId of missing) void start(orderId)
    return
  }

  await mapPool(missing, concurrency, async (orderId) => {
    await start(orderId)
  })
}
