import { NextResponse } from "next/server"
import { buildAttentionQueue, ensureDemoSeed } from "@/lib/agent/control-room"

export const runtime = "nodejs"

export async function GET() {
  try {
    await ensureDemoSeed()
    const body = await buildAttentionQueue()
    return NextResponse.json(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load control room"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
