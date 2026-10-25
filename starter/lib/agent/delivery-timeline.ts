import "server-only"

import { obj, originPickupPoint, recordedAt, rows, str } from "@/lib/present/bundle"
import type { OrderLoad } from "@/lib/present/load"
import { fmtDay, fmtDayRange } from "@/lib/present/time"
import { placeFromText, resolveCurrentLocation } from "./current-location"
import { resolveDeliveryJourney } from "./delivery-stage"
import type {
  AgentRunRecord,
  DeliveryTimeline,
  DeliveryTimelineStep,
  JourneyLegState,
} from "./types"

function cityCountry(city: string | null | undefined, country: string | null | undefined): string | null {
  if (!city?.trim()) return null
  return country?.trim() ? `${city.trim()}, ${country.trim()}` : city.trim()
}

function occurredAt(event: { recordedAt: string; details: Record<string, unknown> } | null): string | null {
  if (!event) return null
  const changes = obj(event.details.changes)
  return str(changes?.occurred_at) ?? event.recordedAt
}

function deliveryPromise(loaded: OrderLoad): {
  start: string | null
  end: string | null
  zone: string | null
} {
  for (const row of rows(loaded.bundle, "time_windows")) {
    if (str(row.details.purpose) !== "CUSTOMER_DELIVERY_PROMISE") continue
    return {
      start: str(row.details.start_at),
      end: str(row.details.end_at),
      zone: str(row.details.timezone),
    }
  }
  return { start: null, end: null, zone: null }
}

function pickupSlot(loaded: OrderLoad): { start: string | null; end: string | null; zone: string | null } {
  const windows = rows(loaded.bundle, "time_windows")
  const selected = windows.find((row) => str(row.details.purpose) === "SELECTED_PICKUP_SLOT")
    ?? windows.find((row) => str(row.details.purpose) === "PICKUP_AVAILABILITY")
  if (!selected) return { start: null, end: null, zone: null }
  return {
    start: str(selected.details.start_at),
    end: str(selected.details.end_at),
    zone: str(selected.details.timezone),
  }
}

function primaryProblemAlert(loaded: OrderLoad) {
  const open = loaded.alerts.filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
  const rank = (signal: string) =>
    /SAFETY|ROADSIDE/i.test(signal) ? 0
      : /FERRY|SOLD/i.test(signal) ? 1
        : /TRACKING/i.test(signal) ? 3
          : 2
  return [...open].sort((a, b) => {
    const ta = a.triggeredAt instanceof Date ? a.triggeredAt.toISOString() : String(a.triggeredAt)
    const tb = b.triggeredAt instanceof Date ? b.triggeredAt.toISOString() : String(b.triggeredAt)
    return rank(a.signal) - rank(b.signal) || ta.localeCompare(tb)
  })[0] ?? null
}

function shiftIsoDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

function mapState(state: JourneyLegState): DeliveryTimelineStep["state"] {
  if (state === "done") return "done"
  if (state === "current" || state === "blocked") return "current"
  return "upcoming"
}

function mapTone(
  tone: "danger" | "warn" | "accent" | "ok" | "neutral",
): DeliveryTimelineStep["tone"] {
  if (tone === "danger") return "danger"
  if (tone === "warn") return "warn"
  if (tone === "ok" || tone === "accent") return "ok"
  return "neutral"
}

/**
 * One dated story for the decision card: pickup → drive / ferry / problem →
 * optional branch → must deliver → now expected. Journey legs live here — no
 * separate Delivery journey panel. Dates only (no clock / timezone).
 */
export function resolveDeliveryTimeline(
  loaded: OrderLoad,
  run?: AgentRunRecord | null,
): DeliveryTimeline {
  const pickupCity = cityCountry(loaded.pickup?.city, loaded.pickup?.country)
  const deliveryCity = cityCountry(loaded.delivery?.city, loaded.delivery?.country)
  const origin = originPickupPoint(loaded.bundle)
  const pickedEvent = recordedAt(loaded.bundle, "vehicle.picked_up", origin?.id)
    ?? loaded.bundle.events.find((event) => event.command === "vehicle.picked_up")
    ?? null
  const pickedAt = occurredAt(pickedEvent)
  const slot = pickupSlot(loaded)
  const promise = deliveryPromise(loaded)
  const zone = promise.zone ?? slot.zone
  const alert = primaryProblemAlert(loaded)
  const location = resolveCurrentLocation(loaded, run)
  const problemPlace =
    (location.known ? location.label : null)
    ?? (alert ? placeFromText(alert.summary) : null)
    ?? pickupCity
  const journey = resolveDeliveryJourney(loaded.bundle)
  const problemIso = alert
    ? (alert.triggeredAt instanceof Date ? alert.triggeredAt.toISOString() : String(alert.triggeredAt))
    : null
  const pickupIso = pickedAt ?? slot.start
  const pickupDay = pickupIso ? fmtDay(pickupIso, zone) : null
  // Keep the strip chronological when the alert fired before the pickup slot in the snapshot.
  const problemIsoClamped =
    problemIso && pickupIso && new Date(problemIso).getTime() < new Date(pickupIso).getTime()
      ? pickupIso
      : problemIso
  const problemDay = problemIsoClamped ? fmtDay(problemIsoClamped, zone) : null
  const safety = Boolean(alert && /SAFETY|ROADSIDE/i.test(alert.signal))
  const ferryAlert = Boolean(alert && /FERRY|SOLD/i.test(alert.signal))

  const steps: DeliveryTimelineStep[] = []
  const pickupLeg = journey.legs.find((leg) => leg.kind === "pickup")
  const pickedDone = pickupLeg?.state === "done" || Boolean(pickedAt)

  if (pickedDone && pickupDay) {
    steps.push({
      id: "pickup",
      kind: "pickup",
      label: "Picked up",
      whenLabel: pickupDay,
      whereLabel: pickupCity ?? pickupLeg?.detail ?? null,
      detail: null,
      tone: "ok",
      state: "done",
    })
  } else if (pickupDay) {
    steps.push({
      id: "pickup",
      kind: "pickup",
      label: "Pickup planned",
      whenLabel: pickupDay,
      whereLabel: pickupCity ?? pickupLeg?.detail ?? null,
      detail: "Not picked up yet",
      tone: "warn",
      state: "upcoming",
    })
  } else {
    steps.push({
      id: "pickup",
      kind: "pickup",
      label: "Pickup",
      whenLabel: "Date not on record",
      whereLabel: pickupCity ?? pickupLeg?.detail ?? null,
      detail: null,
      tone: "neutral",
      state: "unknown",
    })
  }

  // Journey mid-legs (drive / ferry) with dates — skip pickup + handover (handover folds into Must deliver).
  // On ferry sold-out cases, skip quiet "drive to port" so the horizontal strip stays scannable.
  for (const leg of journey.legs) {
    if (leg.kind === "pickup" || leg.kind === "handover") continue
    if (ferryAlert && leg.kind === "drive" && leg.state !== "blocked") continue

    const isBottleneck = leg.state === "blocked"
    let whenLabel: string
    if (leg.kind === "ferry" && problemDay) whenLabel = problemDay
    else if (leg.kind === "drive" && isBottleneck && problemDay) whenLabel = problemDay
    else if (pickupDay) whenLabel = pickupDay
    else whenLabel = problemDay || "—"

    let detail = leg.note
    if (leg.kind === "ferry" && isBottleneck && !detail) {
      detail = ferryAlert ? "Sold out" : "At risk"
    }
    if (leg.kind === "drive" && isBottleneck && safety) {
      detail = detail ?? "Roadside stop"
    }

    // Prefer port / corridor place; fold short sold-out into where when ferry blocked.
    let whereLabel = leg.detail
    if (leg.kind === "ferry" && isBottleneck) {
      const sold = /sold out/i.test(leg.note ?? "") || ferryAlert
      whereLabel = whereLabel
        ? (sold && !/sold out/i.test(whereLabel) ? `${whereLabel.split(" · ")[0]} · sold out` : whereLabel)
        : (problemPlace ?? "Ferry port")
    }

    steps.push({
      id: leg.id,
      kind: leg.kind === "ferry" ? "ferry" : "drive",
      label: leg.label,
      whenLabel,
      whereLabel,
      detail: detail && whereLabel && /sold out/i.test(whereLabel) && /sold out/i.test(detail)
        ? null
        : detail,
      tone: mapTone(leg.tone),
      state: mapState(leg.state),
    })
  }

  // Inland roadside with no drive leg note — keep an explicit problem step.
  const hasBlockedLeg = steps.some((step) => step.state === "current" && (step.kind === "drive" || step.kind === "ferry") && (step.tone === "danger" || step.tone === "warn"))
  if (alert && !hasBlockedLeg) {
    const problemTitle = safety
      ? "Problem · roadside stop"
      : ferryAlert
        ? "Problem · ferry capacity"
        : `Problem · ${alert.signal.replace(/_/g, " ").toLowerCase()}`
    steps.push({
      id: "problem",
      kind: "problem",
      label: problemTitle,
      whenLabel: problemDay || "Date not on record",
      whereLabel: problemPlace,
      detail: alert.summary,
      tone: safety ? "danger" : "warn",
      state: "current",
    })
  }

  const promised = promise.start ? fmtDayRange(promise.start, promise.end, promise.zone) : null
  // Prefer recommended option arrival (same source as Booking draft / delay chip).
  const recommended =
    run?.decision.options.find((o) => o.id === run.decision.recommendationId)
    ?? run?.decision.options[0]
    ?? null
  const fromOption = recommended?.arrivalLabel?.trim() || null
  const fromTiming = run?.decision.deliveryTiming?.expectedLabel
    ?.replace(/^Now expected\s+/i, "")
    .trim() || null
  const delayDays = safety || ferryAlert ? 1 : 0
  const expectedStart = delayDays && promise.start ? shiftIsoDays(promise.start, delayDays) : null
  const expectedFallback = expectedStart ? fmtDayRange(expectedStart, null, promise.zone) : null
  const expected = fromOption || fromTiming || expectedFallback

  if (promise.start) {
    steps.push({
      id: "delivery",
      kind: "delivery",
      label: "Must deliver",
      whenLabel: promised || "Promise not on record",
      whereLabel: deliveryCity,
      detail: null,
      tone: expected ? (safety ? "danger" : "warn") : "neutral",
      state: "upcoming",
    })
    if (expected) {
      steps.push({
        id: "expected",
        kind: "expected",
        label: "Now expected",
        whenLabel: expected,
        whereLabel: deliveryCity,
        detail: safety
          ? "Car cannot continue"
          : ferryAlert
            ? (recommended?.lineName
              ? `${recommended.lineName} · ~30 h sea`
              : "Next Finnlines sailing")
            : null,
        tone: safety ? "danger" : "warn",
        state: "upcoming",
      })
    }
  } else {
    steps.push({
      id: "delivery",
      kind: "delivery",
      label: "Must deliver",
      whenLabel: "Promise not on record",
      whereLabel: deliveryCity,
      detail: null,
      tone: "neutral",
      state: "unknown",
    })
  }

  return {
    steps,
    bottleneck: journey.bottleneck,
    promisedLabel: promised,
    source: [
      journey.source,
      pickedAt ? "event=vehicle.picked_up" : null,
      alert ? `alert=${alert.signal}` : null,
      promise.start ? "window=CUSTOMER_DELIVERY_PROMISE" : null,
    ].filter(Boolean).join(" · ") || "partial",
  }
}
