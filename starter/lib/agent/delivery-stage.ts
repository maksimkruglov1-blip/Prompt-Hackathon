import "server-only"

import { type Bundle, rows, str } from "@/lib/present/bundle"
import { label, laneLabel } from "@/lib/present/labels"
import type { Tone } from "@/lib/present/types"
import type { DeliveryJourney, DeliveryJourneyLeg, JourneyLegState } from "./types"

export type DeliveryStage = {
  /** Full line for the decision card, e.g. "Roadside stop · Munich → Hamburg". */
  label: string
  /** Short chip for the queue row. */
  short: string
  /** Raw codes used (for debugging / sources). */
  source: string
  tone: Tone
  known: boolean
}

function cityOf(bundle: Bundle, addressId: string | null | undefined): string | null {
  if (!addressId) return null
  return bundle.places.get(addressId)?.city ?? null
}

function openSignals(bundle: Bundle): string[] {
  return bundle.alerts
    .filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED")
    .map((a) => a.signal)
}

function activeReservation(bundle: Bundle): { kind: string; status: string; from: string | null; to: string | null } | null {
  const list = rows(bundle, "travel_reservations")
  const preferred = list
    .map((row) => row.details)
    .find((d) => {
      const status = str(d.status) ?? ""
      return status === "BOOKED" || status === "CHECKED_IN" || status === "IN_PROGRESS" || status === "CONFIRMED"
    })
    ?? list.map((row) => row.details).find((d) => (str(d.status) ?? "") === "SOLD_OUT")
    ?? null
  if (!preferred) return null
  return {
    kind: str(preferred.kind) ?? "TRAVEL",
    status: str(preferred.status) ?? "",
    from: str(preferred.from_name) ?? str(preferred.origin_name) ?? str(preferred.departure_port) ?? null,
    to: str(preferred.to_name) ?? str(preferred.destination_name) ?? str(preferred.arrival_port) ?? null,
  }
}

function activeSegment(bundle: Bundle): { status: string; fromCity: string | null; toCity: string | null } | null {
  const segments = rows(bundle, "transport_segments")
  const points = new Map(rows(bundle, "transport_points").map((row) => [row.id, row.details]))
  const ranked = [...segments].sort((a, b) => {
    const rank = (status: string | null) =>
      status === "IN_PROGRESS" ? 0 : status === "ASSIGNED" ? 1 : status === "PLANNED" ? 2 : 3
    return rank(str(a.details.status)) - rank(str(b.details.status))
  })
  const top = ranked[0]
  if (!top) return null
  const fromId = str(top.details.from_point_id)
  const toId = str(top.details.to_point_id)
  const fromPoint = fromId ? points.get(fromId) : null
  const toPoint = toId ? points.get(toId) : null
  const fromCity = str(fromPoint?.city) ?? (fromId ? cityOf(bundle, fromId) : null)
  const toCity = str(toPoint?.city) ?? (toId ? cityOf(bundle, toId) : null)
  // transport_points store place via address / name — fall back to order ends when cities missing.
  return {
    status: str(top.details.status) ?? "PLANNED",
    fromCity: fromCity || cityOf(bundle, bundle.order.pickupAddressId),
    toCity: toCity || cityOf(bundle, bundle.order.deliveryAddressId),
  }
}

function routePhrase(from: string | null, to: string | null): string | null {
  if (from && to) return `${from} → ${to}`
  if (to) return `to ${to}`
  if (from) return `from ${from}`
  return null
}

/**
 * Where the car is in the delivery process (lane / plan / travel / last disruption),
 * not GPS. English labels for Control Room.
 */
export function resolveDeliveryStage(bundle: Bundle): DeliveryStage {
  const { order } = bundle
  const from = cityOf(bundle, order.pickupAddressId)
  const to = cityOf(bundle, order.deliveryAddressId)
  const route = routePhrase(from, to)
  const signals = openSignals(bundle)
  const reservation = activeReservation(bundle)
  const segment = activeSegment(bundle)
  const plan = rows(bundle, "transport_plans").find((row) => str(row.details.status) === "ACTIVE")
    ?? rows(bundle, "transport_plans")[0]
    ?? null
  const planStatus = plan ? str(plan.details.status) : null
  const assignment = rows(bundle, "work_assignments")
    .map((row) => row.details)
    .find((d) => {
      const status = str(d.status) ?? ""
      return status === "IN_PROGRESS" || status === "ASSIGNED"
    })

  const sourceParts = [
    `lane=${order.lane}`,
    `status=${order.status}`,
    planStatus ? `plan=${planStatus}` : null,
    reservation ? `travel=${reservation.kind}:${reservation.status}` : null,
    segment ? `segment=${segment.status}` : null,
    signals[0] ? `alert=${signals[0]}` : null,
  ].filter(Boolean)

  // Disruption first — ops care about the stop more than the lane.
  if (signals.some((s) => s.includes("SAFETY") || s.includes("ROADSIDE"))) {
    return {
      label: route ? `Roadside stop · ${route}` : "Roadside stop",
      short: "Roadside stop",
      source: sourceParts.join(" · "),
      tone: "danger",
      known: true,
    }
  }

  if (signals.some((s) => s.includes("FERRY"))) {
    const ferryRoute = routePhrase(reservation?.from ?? from, reservation?.to ?? to) ?? route
    const soldOut = signals.some((s) => s.includes("SOLD_OUT")) || reservation?.status === "SOLD_OUT"
    return {
      label: ferryRoute
        ? (soldOut ? `Awaiting ferry · ${ferryRoute}` : `Ferry at risk · ${ferryRoute}`)
        : (soldOut ? "Awaiting ferry" : "Ferry at risk"),
      short: soldOut ? "Awaiting ferry" : "Ferry at risk",
      source: sourceParts.join(" · "),
      tone: "warn",
      known: true,
    }
  }

  if (reservation && /FERRY|CROSSING|SAILING/i.test(reservation.kind) && /BOOKED|CHECKED_IN|IN_PROGRESS|CONFIRMED/i.test(reservation.status)) {
    const ferryRoute = routePhrase(reservation.from, reservation.to) ?? route
    return {
      label: ferryRoute ? `On ferry · ${ferryRoute}` : "On ferry",
      short: "On ferry",
      source: sourceParts.join(" · "),
      tone: "accent",
      known: true,
    }
  }

  if (order.lane === "moving" || order.status === "IN_TRANSIT" || segment?.status === "IN_PROGRESS") {
    const movingRoute = routePhrase(segment?.fromCity ?? from, segment?.toCity ?? to) ?? route
    if (signals.some((s) => s.includes("TRACKING"))) {
      return {
        label: movingRoute ? `En route · position unknown · ${movingRoute}` : "En route · position unknown",
        short: "En route",
        source: sourceParts.join(" · "),
        tone: "warn",
        known: true,
      }
    }
    return {
      label: movingRoute ? `En route · ${movingRoute}` : "En route",
      short: "En route",
      source: sourceParts.join(" · "),
      tone: "accent",
      known: true,
    }
  }

  if (order.lane === "booked" || assignment) {
    const awaitingPickup = order.status === "WAITING_FOR_PICKUP" || segment?.status === "ASSIGNED"
    if (awaitingPickup) {
      return {
        label: route ? `En route to pickup · ${route}` : "En route to pickup",
        short: "To pickup",
        source: sourceParts.join(" · "),
        tone: "warn",
        known: true,
      }
    }
    return {
      label: route ? `Driver assigned · ${route}` : "Driver assigned",
      short: "Driver assigned",
      source: sourceParts.join(" · "),
      tone: "warn",
      known: true,
    }
  }

  if (order.lane === "market") {
    return {
      label: "Finding a driver",
      short: "Finding driver",
      source: sourceParts.join(" · "),
      tone: "warn",
      known: true,
    }
  }

  if (order.lane === "ready") {
    return {
      label: "Awaiting handover",
      short: "Awaiting handover",
      source: sourceParts.join(" · "),
      tone: "warn",
      known: true,
    }
  }

  if (order.lane === "delivered" || order.status === "DELIVERED") {
    return {
      label: to ? `Delivered · ${to}` : "Delivered",
      short: "Delivered",
      source: sourceParts.join(" · "),
      tone: "ok",
      known: true,
    }
  }

  if (order.lane === "cancelled" || order.status === "CANCELLED") {
    return {
      label: "Cancelled",
      short: "Cancelled",
      source: sourceParts.join(" · "),
      tone: "neutral",
      known: true,
    }
  }

  if (order.lane === "intake" || order.status === "NEW" || order.status === "PREPARING") {
    return {
      label: label(order.status) ? `${label(order.status)} · ${laneLabel(order.lane)}` : "New order · preparing",
      short: "Preparing",
      source: sourceParts.join(" · "),
      tone: "warn",
      known: true,
    }
  }

  // Fall back to lane + status if we have them; otherwise calm empty.
  if (order.lane || order.status) {
    const lane = order.lane ? laneLabel(order.lane) : null
    const status = order.status ? label(order.status) : null
    const combined = [status, lane].filter(Boolean).join(" · ")
    return {
      label: route ? `${combined} · ${route}` : combined || "Stage unknown",
      short: status || lane || "Stage unknown",
      source: sourceParts.join(" · "),
      tone: "neutral",
      known: Boolean(combined),
    }
  }

  return {
    label: "Stage unknown",
    short: "Stage unknown",
    source: "missing",
    tone: "neutral",
    known: false,
  }
}

function countryOf(bundle: Bundle, addressId: string | null | undefined): string | null {
  if (!addressId) return null
  return bundle.places.get(addressId)?.country ?? null
}

function isGenericTerminal(name: string | null | undefined): boolean {
  if (!name) return true
  return /terminal|west baltic|south finland|north sea|corridor/i.test(name)
}

/** Prefer real Baltic port names when travel data only has generic terminal labels. */
function ferryPorts(
  bundle: Bundle,
  fromHint: string | null,
  toHint: string | null,
): { from: string; to: string } {
  const pickupCountry = countryOf(bundle, bundle.order.pickupAddressId)
  const deliveryCity = cityOf(bundle, bundle.order.deliveryAddressId)
  const deliveryCountry = countryOf(bundle, bundle.order.deliveryAddressId)
  let from = fromHint && !isGenericTerminal(fromHint) ? fromHint : null
  let to = toHint && !isGenericTerminal(toHint) ? toHint : null
  if (!from && pickupCountry === "DE" && (deliveryCountry === "FI" || deliveryCountry === "EE")) {
    from = "Travemünde"
  }
  // Finnlines DE→FI berths at Helsinki Vuosaari (not a Tallink/Viking city terminal).
  if (!to && deliveryCountry === "FI") to = "Vuosaari (Helsinki)"
  if (!to && deliveryCountry === "EE") to = deliveryCity ?? "Tallinn"
  return {
    from: from ?? fromHint ?? "Ferry port",
    to: to ?? toHint ?? (deliveryCity ?? "Destination"),
  }
}

function ferryTravel(bundle: Bundle): {
  from: string | null
  to: string | null
  status: string
  soldOut: boolean
  provider: string | null
} | null {
  const reservation = activeReservation(bundle)
  if (reservation && /FERRY|CROSSING|SAILING/i.test(reservation.kind)) {
    return {
      from: reservation.from,
      to: reservation.to,
      status: reservation.status,
      soldOut: reservation.status === "SOLD_OUT",
      provider: null,
    }
  }
  const options = rows(bundle, "travel_options")
    .map((row) => row.details)
    .filter((d) => /FERRY|CROSSING|SAILING/i.test(str(d.kind) ?? ""))
  if (!options.length) return null
  const sold = options.find((d) => str(d.status) === "SOLD_OUT")
  const pick = sold ?? options[0]!
  return {
    from: str(pick.from_city) ?? str(pick.from_name) ?? str(pick.departure_port),
    to: str(pick.to_city) ?? str(pick.to_name) ?? str(pick.arrival_port),
    status: str(pick.status) ?? "",
    soldOut: str(pick.status) === "SOLD_OUT" || Boolean(str(pick.capacity_note)?.match(/unavailable|sold.?out/i)),
    provider: str(pick.provider),
  }
}

function segmentNeedsSea(bundle: Bundle): boolean {
  const modes = rows(bundle, "transport_segments").map((row) => str(row.details.transport_mode) ?? "")
  if (modes.some((m) => /FERRY|SEA|CROSSING/i.test(m))) return true
  return ferryTravel(bundle) != null
}

/**
 * Full delivery chain for the decision card: Pickup → Drive → (Ferry) → Handover.
 * Marks current / blocked / still-OK steps from plan, segments, travel, and alerts.
 * Never invents a ferry leg for inland same-country drives.
 */
export function resolveDeliveryJourney(bundle: Bundle): DeliveryJourney {
  const from = cityOf(bundle, bundle.order.pickupAddressId)
  const to = cityOf(bundle, bundle.order.deliveryAddressId)
  const fromCountry = countryOf(bundle, bundle.order.pickupAddressId)
  const toCountry = countryOf(bundle, bundle.order.deliveryAddressId)
  const inlandSameCountry = Boolean(fromCountry && toCountry && fromCountry === toCountry)
  const signals = openSignals(bundle)
  const safety = signals.some((s) => s.includes("SAFETY") || s.includes("ROADSIDE"))
  const ferryAlert = signals.some((s) => s.includes("FERRY"))
  const travel = ferryTravel(bundle)
  const needsFerry = !inlandSameCountry && (segmentNeedsSea(bundle) || ferryAlert || travel != null)

  const segment = activeSegment(bundle)
  const waitingPickup =
    bundle.order.status === "WAITING_FOR_PICKUP"
    || bundle.order.status === "NEW"
    || bundle.order.status === "PREPARING"
  const inTransit =
    bundle.order.status === "IN_TRANSIT"
    || bundle.order.lane === "moving"
    || segment?.status === "IN_PROGRESS"
  const delivered = bundle.order.status === "DELIVERED" || bundle.order.lane === "delivered"

  const sourceParts = [
    needsFerry ? "sea=yes" : "sea=no",
    travel ? `travel=${travel.status}` : null,
    segment ? `segment=${segment.status}` : null,
    signals[0] ? `alert=${signals[0]}` : null,
  ].filter(Boolean)

  const legs: DeliveryJourneyLeg[] = []

  // 1. Pickup
  let pickupState: JourneyLegState = "upcoming"
  let pickupTone: DeliveryJourneyLeg["tone"] = "neutral"
  if (delivered || inTransit || (!waitingPickup && segment)) {
    pickupState = "done"
    pickupTone = "ok"
  } else if (waitingPickup && !ferryAlert) {
    pickupState = "current"
    pickupTone = "warn"
  } else if (waitingPickup && ferryAlert) {
    // Car not moving yet, but bottleneck is ferry capacity — pickup still OK / ready.
    pickupState = "done"
    pickupTone = "ok"
  }
  legs.push({
    id: "pickup",
    kind: "pickup",
    label: "Pickup",
    detail: from,
    note: pickupState === "current" ? "Awaiting pickup" : null,
    state: pickupState,
    tone: pickupTone,
  })

  if (needsFerry) {
    const ports = ferryPorts(bundle, travel?.from ?? null, travel?.to ?? null)
    const soldOut = Boolean(travel?.soldOut) || signals.some((s) => s.includes("SOLD_OUT"))

    // 2. Drive to ferry port
    let driveState: JourneyLegState = "upcoming"
    let driveTone: DeliveryJourneyLeg["tone"] = "neutral"
    if (delivered) {
      driveState = "done"
      driveTone = "ok"
    } else if (inTransit && !soldOut) {
      driveState = "current"
      driveTone = "accent"
    } else if (pickupState === "done" && soldOut) {
      // Ops still need the sailing — road to port is not the issue yet.
      driveState = "upcoming"
      driveTone = "neutral"
    }
    legs.push({
      id: "drive-to-port",
      kind: "drive",
      label: "Drive",
      detail: from && ports.from ? `${from} → ${ports.from}` : ports.from,
      note: null,
      state: driveState,
      tone: driveTone,
    })

    // 3. Ferry — bottleneck when sold out / capacity alert
    let ferryState: JourneyLegState = "upcoming"
    let ferryTone: DeliveryJourneyLeg["tone"] = "neutral"
    let ferryNote: string | null = null
    if (soldOut || ferryAlert) {
      ferryState = "blocked"
      ferryTone = "danger"
      ferryNote = soldOut ? "Sold out · capacity" : "Ferry at risk"
    } else if (inTransit) {
      ferryState = "current"
      ferryTone = "accent"
      ferryNote = travel?.status === "BOOKED" ? "Booked" : null
    }
    const finnlinesCorridor = fromCountry === "DE" && toCountry === "FI"
    legs.push({
      id: "ferry",
      kind: "ferry",
      label: finnlinesCorridor ? "Ferry · Finnlines" : "Ferry",
      detail: finnlinesCorridor
        ? `${ports.from} → ${ports.to} · Finnstar / Finnmaid / Finnlady`
        : `${ports.from} → ${ports.to}`,
      note: ferryNote,
      state: ferryState,
      tone: ferryTone,
    })

    // 4. Handover
    legs.push({
      id: "handover",
      kind: "handover",
      label: "Handover",
      detail: to,
      note: null,
      state: delivered ? "done" : "upcoming",
      tone: delivered ? "ok" : "neutral",
    })

    const bottleneck = ferryState === "blocked"
      ? `Delay hits the ferry leg (${ports.from} → ${ports.to})${soldOut ? " — sold out / capacity" : ""}. Finnlines sea leg is still required — driver rest hours block long extra driving; book the next sailing (+ hotel/rest if waiting).`
      : null

    // No alternate land crossing — Finnlines mandatory; next sailing (+ hotel) only.
    return { legs, bottleneck, branch: null, source: sourceParts.join(" · ") }
  }

  // Inland / no sea leg — never invent a ferry.
  let driveState: JourneyLegState = "upcoming"
  let driveTone: DeliveryJourneyLeg["tone"] = "neutral"
  let driveNote: string | null = null
  if (delivered) {
    driveState = "done"
    driveTone = "ok"
  } else if (safety) {
    driveState = "blocked"
    driveTone = "danger"
    driveNote = "Roadside stop"
  } else if (inTransit) {
    driveState = "current"
    driveTone = "accent"
  } else if (pickupState === "done") {
    driveState = "current"
    driveTone = "warn"
  }

  legs.push({
    id: "drive",
    kind: "drive",
    label: "Drive",
    detail: from && to ? `${from} → ${to}` : to ?? from,
    note: driveNote,
    state: driveState,
    tone: driveTone,
  })

  legs.push({
    id: "handover",
    kind: "handover",
    label: "Handover",
    detail: to,
    note: null,
    state: delivered ? "done" : "upcoming",
    tone: delivered ? "ok" : "neutral",
  })

  const bottleneck = safety
    ? `Delay hits the drive leg${from && to ? ` (${from} → ${to})` : ""} — roadside stop; recovery first.`
    : null

  return { legs, bottleneck, branch: null, source: sourceParts.join(" · ") }
}
