import { NextResponse } from "next/server"
import { buildAttentionQueue, ensureDemoSeed } from "@/lib/agent/control-room"
import { humanizeApiError } from "@/lib/agent/ui-copy"

export const runtime = "nodejs"

export async function GET() {
  try {
    await ensureDemoSeed()
    const body = await buildAttentionQueue()
    return NextResponse.json(body)
  } catch (error) {
    console.error("control-room queue failed", error)
    return NextResponse.json({ error: humanizeApiError(error, "Could not load the attention queue") }, { status: 500 })
  }
}
