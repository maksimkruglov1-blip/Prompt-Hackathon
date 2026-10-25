import { NextResponse } from "next/server"
import { buildDecisionCard } from "@/lib/agent/control-room"
import { humanizeApiError } from "@/lib/agent/ui-copy"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params
  try {
    const body = await buildDecisionCard(orderId, { ensureAgent: false })
    if (!body) return NextResponse.json({ error: "Order not found" }, { status: 404 })
    return NextResponse.json(body)
  } catch (error) {
    console.error("control-room decision failed", error)
    return NextResponse.json({ error: humanizeApiError(error, "Could not load the decision card") }, { status: 500 })
  }
}
