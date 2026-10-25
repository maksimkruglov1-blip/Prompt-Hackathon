import "server-only"

import type { OrderLoad } from "@/lib/present/load"
import type { AgentAction, AgentRunRecord, DriverChatMessage, DriverChatThread } from "./types"

const CUSTOMER_AUTHOR = /^(customer|buyer|dealer_customer|paying)/i

function roleFromAuthorType(authorType: string): DriverChatMessage["role"] | null {
  const t = authorType.trim().toLowerCase()
  if (CUSTOMER_AUTHOR.test(t)) return null
  if (t === "driver") return "driver"
  if (t === "operator" || t === "ops" || t === "human") return "ops"
  if (t === "agent") return "agent"
  // Unknown non-customer authors stay out of the driver thread.
  return null
}

function roleLabel(role: DriverChatMessage["role"]): string {
  if (role === "driver") return "Driver"
  if (role === "ops") return "Ops"
  return "Agent"
}

function stripDriverNamePrefix(body: string, driverName: string | null): string {
  let text = body.trim()
  if (driverName) {
    const re = new RegExp(`^${driverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i")
    text = text.replace(re, "")
  }
  text = text.replace(/^(the driver|driver)\s*:\s*/i, "")
  return text.trim()
}

function questionFromAskAction(action: AgentAction): string {
  const fromSummary = action.summary.match(/^Asked driver:\s*(.+)$/i)
  if (fromSummary?.[1]) return fromSummary[1].trim()
  return action.summary.replace(/^ask_driver[:\s]*/i, "").trim() || "Check-in with driver"
}

/**
 * Build the ops-facing driver chat for a decision card.
 * Dataset messages (never paying customer) + ask_driver Q&A from the agent run.
 */
export function buildDriverChat(
  loaded: OrderLoad,
  run: AgentRunRecord | null | undefined,
): DriverChatThread {
  const driver = loaded.drivers[0] ?? null
  const driverName = driver?.displayName ?? null
  const messages: DriverChatMessage[] = []

  for (const row of loaded.messages) {
    const role = roleFromAuthorType(row.authorType)
    if (!role) continue
    const body = String(row.body ?? "").trim()
    if (!body) continue
    const at = row.authoredAt instanceof Date
      ? row.authoredAt.toISOString()
      : typeof row.authoredAt === "string"
        ? row.authoredAt
        : new Date(String(row.authoredAt)).toISOString()
    messages.push({
      id: `msg-${row.id}`,
      role,
      roleLabel: roleLabel(role),
      body,
      at,
      source: "dataset",
    })
  }

  const actions = [
    ...(run?.decision.actions ?? []),
    ...(run?.toolTrace ?? []),
  ]
  const seenAsk = new Set<string>()
  let askIndex = 0
  for (const action of actions) {
    if (action.tool !== "ask_driver") continue
    const question = questionFromAskAction(action)
    const replyRaw = (action.detail ?? "").trim()
    const key = `${question}::${replyRaw}`
    if (seenAsk.has(key)) continue
    seenAsk.add(key)

    const baseMs = Date.parse(action.at) || Date.now()
    // Stagger same-timestamp tool turns so the thread reads as Q then A.
    const askAt = new Date(baseMs + askIndex * 120_000).toISOString()
    const replyAt = new Date(baseMs + askIndex * 120_000 + 45_000).toISOString()
    askIndex += 1

    messages.push({
      id: `ask-${askIndex}-q`,
      role: "agent",
      roleLabel: "Agent",
      body: question,
      at: askAt,
      source: "ask_driver",
    })
    if (replyRaw) {
      messages.push({
        id: `ask-${askIndex}-a`,
        role: "driver",
        roleLabel: "Driver",
        body: stripDriverNamePrefix(replyRaw, driverName),
        at: replyAt,
        source: "ask_driver",
      })
    }
  }

  messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))

  return {
    driverName,
    subtitle: driverName
      ? `Thread with ${driverName} · never the paying customer`
      : "Driver thread · never the paying customer",
    messages,
  }
}
