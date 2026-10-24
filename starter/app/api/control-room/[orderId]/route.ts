import { NextResponse } from "next/server"
import { buildDecisionCard } from "@/lib/agent/control-room"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params
  try {
    const body = await buildDecisionCard(orderId, { ensureAgent: false })
    if (!body) return NextResponse.json({ error: "Order not found" }, { status: 404 })
    return NextResponse.json(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load decision"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
