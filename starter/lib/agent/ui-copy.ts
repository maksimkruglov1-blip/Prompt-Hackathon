/** Ops-facing labels for agent fact provenance (decision card). */
export const FACT_SOURCE_KIND_LABEL: Record<string, string> = {
  driver: "Driver chat",
  message: "Order messages",
  order: "Order record",
  alert: "Open alert",
  vehicle: "Vehicle record",
  tool: "Agent tool",
  site: "Site record",
}

/** Map raw tool/source strings to a short calm label. */
export function factSourceLabel(source: string, sourceKind?: string): string {
  const raw = (source || "").trim()
  const lower = raw.toLowerCase()
  if (/search_trips|trip catalog|catalog/i.test(raw)) return "search_trips catalog"
  if (/mock driver|driver chat/i.test(raw)) return "Driver chat"
  if (/mock roadside|estimate_recovery|tow quote/i.test(raw)) return "Tow estimate (mock)"
  if (/mock ferry|quote_ferry/i.test(raw)) return "Ferry quote (mock)"
  if (/time_windows|delivery promise|CUSTOMER_DELIVERY/i.test(raw)) return "Delivery promise"
  if (/^orders?$/i.test(raw) || lower.includes("orders")) return "Order record"
  if (/^alert/i.test(raw)) return "Open alert"
  if (/^message/i.test(raw)) return "Order messages"
  if (/customers \(do not contact\)/i.test(raw)) return "Customer record (do not contact)"
  if (/^vehicles?$/i.test(raw)) return "Vehicle record"
  if (/^drivers?$/i.test(raw)) return "Driver record"
  if (/^addresses?|sites?$/i.test(raw)) return "Address / site"
  if (sourceKind && FACT_SOURCE_KIND_LABEL[sourceKind]) return FACT_SOURCE_KIND_LABEL[sourceKind]
  if (raw.length <= 42) return raw
  return `${raw.slice(0, 39)}…`
}

/** Strip SQL / driver dumps so the UI never shows raw Failed query text. */
export function humanizeClientError(message: string, fallback = "Something went wrong. Try again."): string {
  const text = (message || "").trim()
  if (!text) return fallback
  if (/failed query|syntax error|ECONNREFUSED|ECONNRESET|ENOTFOUND|postgres|drizzle|relation \".+\" does not exist|column \".+\"/i.test(text)) {
    return "Could not load data from the local database. Check Docker is up, then refresh."
  }
  if (/OPENAI|LLM error|401|429|fetch failed/i.test(text) && /agent|llm|openai|openrouter/i.test(text)) {
    return "The language model call failed. The mock agent path still works without a key."
  }
  if (text.length > 180) return `${text.slice(0, 160).trim()}…`
  return text
}

export function humanizeApiError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback
  return humanizeClientError(message, fallback)
}
