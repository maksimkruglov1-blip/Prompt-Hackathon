import "server-only"

import { str } from "@/lib/present/bundle"
import type { OrderLoad } from "@/lib/present/load"
import type { AgentFact, AgentRunRecord } from "./types"

export type CurrentLocationView = {
  /** Display line for ops, e.g. "A9 northbound service area near Ingolstadt". */
  label: string
  /** False when we only have the calm unknown state. */
  known: boolean
  /** Short provenance for debugging / secondary UI if needed. */
  source: string
}

const UNKNOWN: CurrentLocationView = {
  label: "Location unknown",
  known: false,
  source: "none",
}

/** Pull a place-like phrase from free text (driver chat, tool reply, alert). */
export function placeFromText(text: string): string | null {
  const raw = text.replace(/\s+/g, " ").trim()
  if (!raw) return null

  const a9 = raw.match(/\bA9\b[^.]{0,80}?(?:near|by)\s+([A-Za-zÄÖÜäöü][\wÄÖÜäöü\-]+)/i)
  if (a9) return `A9 northbound service area near ${a9[1]}`

  if (/service[- ]area/i.test(raw)) {
    const near = raw.match(/(?:near|by|outside)\s+([A-Za-zÄÖÜäöü][\wÄÖÜäöü\-]+)/i)
    if (near) return `Service-area car park near ${near[1]}`
    return "Service-area car park (safe stop)"
  }

  const nearCity = raw.match(/\b(?:near|outside)\s+([A-Za-zÄÖÜäöü][\wÄÖÜäöü\-]+)/i)
  if (nearCity && !/accelerat|warning|photo|issue/i.test(nearCity[1])) {
    return `Near ${nearCity[1]}`
  }

  const terminal = raw.match(/\b((?:West|East|South|North)\s+Baltic terminal)\b/i)
  if (terminal) return terminal[1].replace(/\s+/g, " ").trim()
  if (/\bterminal check-?in\b/i.test(raw)) return "Ferry terminal check-in"
  if (/\bat the terminal\b/i.test(raw)) return "Ferry terminal"

  return null
}

function formatCity(city: string | null | undefined, country: string | null | undefined): string | null {
  if (!city?.trim()) return null
  return country?.trim() ? `${city.trim()}, ${country.trim()}` : city.trim()
}

/**
 * Best-effort “where is the car now” for the decision card.
 * Prefers agent/driver evidence, then travel/pickup context. Never throws.
 */
export function resolveCurrentLocation(
  loaded: OrderLoad,
  run?: AgentRunRecord | null,
  extraFacts?: AgentFact[],
): CurrentLocationView {
  try {
    const facts: AgentFact[] = [
      ...(extraFacts ?? []),
      ...(run?.decision.facts ?? []),
    ]
    for (const fact of [...facts].reverse()) {
      if (/^current location$/i.test(fact.label) && fact.value.trim()) {
        return { label: fact.value.trim(), known: true, source: fact.source }
      }
      if (fact.sourceKind === "driver" || /driver/i.test(fact.label)) {
        const place = placeFromText(fact.value)
        if (place) return { label: place, known: true, source: fact.source }
      }
    }

    if (run?.decision.currentLocation?.trim()) {
      const label = run.decision.currentLocation.trim()
      if (!/^location unknown$/i.test(label)) {
        return { label, known: true, source: "decision" }
      }
    }

    const driverMessages = [...loaded.messages]
      .filter((m) => m.authorType === "driver" || m.authorType === "operator")
      .sort((a, b) => b.authoredAt.getTime() - a.authoredAt.getTime())
    for (const message of driverMessages) {
      const place = placeFromText(message.body)
      if (place) return { label: place, known: true, source: `message ${message.id}` }
    }

    const openAlerts = loaded.alerts.filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
    const isSafety = openAlerts.some((a) => a.signal === "SAFETY_STOP")
    const isFerry = openAlerts.some((a) => a.signal.includes("FERRY"))

    if (isSafety) {
      return { label: "Service-area car park (safe stop)", known: true, source: "alert SAFETY_STOP" }
    }

    const travel = loaded.related.travel_options ?? []
    for (const row of travel) {
      const fromCity = str(row.details.from_city)
      if (fromCity) {
        const status = str(row.details.status) ?? ""
        if (isFerry || /SOLD_OUT|AVAILABLE|QUOTE/i.test(status)) {
          return {
            label: loaded.order.status === "WAITING_FOR_PICKUP"
              ? `${formatCity(loaded.pickup?.city, loaded.pickup?.country) ?? "Pickup"} · ferry via ${fromCity}`
              : `Toward ${fromCity}`,
            known: true,
            source: `travel_options ${row.id}`,
          }
        }
      }
    }

    if (loaded.order.status === "WAITING_FOR_PICKUP") {
      const at = formatCity(loaded.pickup?.city, loaded.pickup?.country)
      if (at) return { label: `${at} · awaiting pickup`, known: true, source: "pickup address" }
    }

    if (loaded.order.status === "IN_TRANSIT" || loaded.order.status === "OUT_FOR_DELIVERY") {
      const from = formatCity(loaded.pickup?.city, loaded.pickup?.country)
      const to = formatCity(loaded.delivery?.city, loaded.delivery?.country)
      if (from && to) {
        return { label: `En route ${from} → ${to}`, known: true, source: "order route" }
      }
    }

    const tracking = [...(loaded.related.tracking_observations ?? [])]
      .map((row) => row.details)
      .sort((a, b) => String(b.observed_at ?? "").localeCompare(String(a.observed_at ?? "")))
    const note = tracking.map((row) => str(row.context_note)).find(Boolean)
    if (note) {
      const place = placeFromText(note) ?? note
      return { label: place, known: true, source: "tracking_observations" }
    }

    return UNKNOWN
  } catch {
    return UNKNOWN
  }
}
