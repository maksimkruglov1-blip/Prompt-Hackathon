import "server-only"

import { desc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { agentRuns } from "@/lib/schema"
import type { AgentDecision, AgentRunRecord, DecisionStatus } from "./types"

function rowToRecord(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status as DecisionStatus,
    mode: row.mode as "mock" | "llm",
    decision: row.decision as unknown as AgentDecision,
    selectedOptionId: row.selectedOptionId,
    changeNote: row.changeNote,
    opsDetails: (row.opsDetails as Record<string, string> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    toolTrace: (row.toolTrace as AgentRunRecord["toolTrace"]) ?? [],
  }
}

export async function latestRunForOrder(orderId: string): Promise<AgentRunRecord | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.orderId, orderId)).orderBy(desc(agentRuns.updatedAt)).limit(1)
  return row ? rowToRecord(row) : null
}

export async function runsByOrderIds(orderIds: string[]): Promise<Map<string, AgentRunRecord>> {
  const map = new Map<string, AgentRunRecord>()
  if (orderIds.length === 0) return map
  const rows = await db.select().from(agentRuns).orderBy(desc(agentRuns.updatedAt))
  for (const row of rows) {
    if (!orderIds.includes(row.orderId) || map.has(row.orderId)) continue
    map.set(row.orderId, rowToRecord(row))
  }
  return map
}

export async function saveRun(record: AgentRunRecord): Promise<AgentRunRecord> {
  await db.insert(agentRuns).values({
    id: record.id,
    orderId: record.orderId,
    status: record.status,
    mode: record.mode,
    decision: record.decision as unknown as Record<string, unknown>,
    selectedOptionId: record.selectedOptionId,
    changeNote: record.changeNote,
    opsDetails: record.opsDetails,
    toolTrace: record.toolTrace as unknown as Record<string, unknown>[],
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  }).onConflictDoUpdate({
    target: agentRuns.id,
    set: {
      status: record.status,
      mode: record.mode,
      decision: record.decision as unknown as Record<string, unknown>,
      selectedOptionId: record.selectedOptionId,
      changeNote: record.changeNote,
      opsDetails: record.opsDetails,
      toolTrace: record.toolTrace as unknown as Record<string, unknown>[],
      updatedAt: new Date(record.updatedAt),
    },
  })
  return record
}

export async function updateRunDecision(
  runId: string,
  patch: {
    status: DecisionStatus
    selectedOptionId: string | null
    changeNote: string | null
    opsDetails?: Record<string, string> | null
  },
): Promise<AgentRunRecord | null> {
  const now = new Date()
  await db.update(agentRuns).set({
    status: patch.status,
    selectedOptionId: patch.selectedOptionId,
    changeNote: patch.changeNote,
    ...(patch.opsDetails !== undefined ? { opsDetails: patch.opsDetails } : {}),
    updatedAt: now,
  }).where(eq(agentRuns.id, runId))
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  return row ? rowToRecord(row) : null
}
