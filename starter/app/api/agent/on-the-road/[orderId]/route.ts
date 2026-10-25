import { NextRequest, NextResponse } from "next/server"
import { buildDecisionCard, invalidateAttentionQueueCache } from "@/lib/agent/control-room"
import { runOnTheRoadAgent } from "@/lib/agent/on-the-road/loop"
import { latestRunForOrder, updateRunDecision } from "@/lib/agent/store"
import type { DecisionStatus } from "@/lib/agent/types"
import { humanizeApiError } from "@/lib/agent/ui-copy"

export const runtime = "nodejs"

/** Run (or re-run) the on-the-road agent for an order. */
export async function POST(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params
  const body = await request.json().catch(() => ({})) as {
    action?: "run" | "decide" | "save_booking_details"
    optionId?: string
    status?: DecisionStatus
    changeNote?: string
    opsGuidance?: string
    /** Reviewed booking draft from the decision card (Approve may persist it). */
    opsDetails?: Record<string, string>
  }

  try {
    if (body.action === "decide") {
      const latest = await latestRunForOrder(orderId)
      if (!latest) return NextResponse.json({ error: "No agent run to decide on" }, { status: 400 })
      const status = body.status === "changed" ? "changed" : body.status === "dismissed" ? "dismissed" : "approved"
      if (status === "approved" && !body.optionId) {
        return NextResponse.json({ error: "optionId required to approve" }, { status: 400 })
      }
      if (status === "approved") {
        const option = latest.decision.options.find((o) => o.id === body.optionId)
        if (!option) return NextResponse.json({ error: "Unknown option" }, { status: 400 })
      }

      // Change: record the note, then re-run the agent with that instruction as a new pending proposal.
      if (status === "changed") {
        const note = body.changeNote?.trim() || "Ops will handle differently"
        await updateRunDecision(latest.id, {
          status: "changed",
          selectedOptionId: null,
          changeNote: note,
          opsDetails: latest.opsDetails,
        })
        const rerun = await runOnTheRoadAgent(orderId, { opsGuidance: note })
        invalidateAttentionQueueCache()
        const card = await buildDecisionCard(orderId)
        return NextResponse.json({
          run: rerun,
          card,
          changeRerun: true,
          previousChangeNote: note,
        })
      }

      const reviewedDraft =
        status === "approved" && body.opsDetails && typeof body.opsDetails === "object"
          ? body.opsDetails
          : status === "approved"
            ? null
            : latest.opsDetails
      const updated = await updateRunDecision(latest.id, {
        status,
        selectedOptionId: status === "approved" ? (body.optionId ?? null) : null,
        changeNote: null,
        opsDetails: reviewedDraft,
      })
      invalidateAttentionQueueCache()
      const card = await buildDecisionCard(orderId)
      return NextResponse.json({ run: updated, card })
    }

    if (body.action === "save_booking_details") {
      const latest = await latestRunForOrder(orderId)
      if (!latest) return NextResponse.json({ error: "No agent run to update" }, { status: 400 })
      if (latest.status !== "approved") {
        return NextResponse.json({ error: "Approve an option before filling booking contacts" }, { status: 400 })
      }
      const option = latest.decision.options.find((o) => o.id === latest.selectedOptionId)
      const fields = option?.bookingFields ?? []
      const details = body.opsDetails ?? {}
      for (const field of fields) {
        if (field.required && !String(details[field.key] ?? "").trim()) {
          return NextResponse.json({ error: `Missing required field: ${field.label}` }, { status: 400 })
        }
      }
      const updated = await updateRunDecision(latest.id, {
        status: latest.status,
        selectedOptionId: latest.selectedOptionId,
        changeNote: latest.changeNote,
        opsDetails: details,
      })
      const card = await buildDecisionCard(orderId)
      return NextResponse.json({ run: updated, card })
    }

    const run = await runOnTheRoadAgent(orderId, { opsGuidance: body.opsGuidance ?? body.changeNote })
    invalidateAttentionQueueCache()
    const card = await buildDecisionCard(orderId)
    return NextResponse.json({ run, card })
  } catch (error) {
    console.error("on-the-road agent failed", error)
    return NextResponse.json({ error: humanizeApiError(error, "The agent could not finish. Try Re-run agent.") }, { status: 500 })
  }
}
