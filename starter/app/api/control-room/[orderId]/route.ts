import { NextResponse } from "next/server"
import { buildDecisionCard } from "@/lib/agent/control-room"
import { humanizeApiError } from "@/lib/agent/ui-copy"

export const runtime = "nodejs"

/**
 * Decision card for one order. Does not seed the whole queue.
 * If a pending proposal still has Baltic ferries on an inland same-country
 * route, it is discarded and re-run here so ops never see the stale options.
 */
export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params
  try {
    const body = await buildDecisionCard(orderId, { ensureAgent: false, refreshStale: true })
    if (!body) return NextResponse.json({ error: "Order not found" }, { status: 404 })
    return NextResponse.json(body)
  } catch (error) {
    console.error("control-room decision failed", error)
    return NextResponse.json({ error: humanizeApiError(error, "Could not load the decision card") }, { status: 500 })
  }
}
