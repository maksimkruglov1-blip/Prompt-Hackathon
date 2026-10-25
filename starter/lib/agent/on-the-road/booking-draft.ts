/** Agent-prefilled booking draft for ops review (never books third-party sites). */

import type { OpsBookingField } from "../types"
import { resolveFerrySchedule } from "./ferry-schedule"
import type { TripCatalogEntry } from "./trip-catalog"

export type BookingDraftContext = {
  orderRef: string
  driverName: string | null
  driverPhone: string | null
  vehicleLabel: string
  vehicleReg: string | null
  vehicleVin: string | null
  vehicleFuel: string | null
  vehicleYear: number | null
  /** Roadside / current stop for tow. */
  pickupLocation: string
  destinationLabel: string
  /**
   * Calendar anchor for sailing/hotel (same day as timeline ferry/problem step).
   * Dates only — no clocks. Relative catalog windows map off this ISO.
   */
  sailingAnchorIso: string | null
  zone: string | null
  /** CUSTOMER_DELIVERY_PROMISE start — delay vs promise uses this. */
  promiseStartIso: string | null
}

/** True when a draft still uses relative day language ops cannot book against. */
export function bookingDraftHasRelativeDates(fields: OpsBookingField[] | undefined): boolean {
  if (!fields?.length) return false
  return fields.some((f) =>
    /tonight|tomorrow|day after|as soon as|night before sailing/i.test(`${f.prefill ?? ""} ${f.placeholder ?? ""}`),
  )
}

function field(
  key: string,
  label: string,
  prefill: string,
  reason: string,
  opts?: { required?: boolean; placeholder?: string },
): OpsBookingField {
  return {
    key,
    label,
    prefill,
    placeholder: opts?.placeholder ?? prefill,
    required: opts?.required ?? true,
    reason,
  }
}

function vehicleLine(ctx: BookingDraftContext): string {
  const plate = ctx.vehicleReg?.trim() || null
  const vinHint = ctx.vehicleVin ? `VIN …${ctx.vehicleVin.slice(-6)}` : null
  if (plate) return `${ctx.vehicleLabel} · ${plate}`
  if (vinHint) return `${ctx.vehicleLabel} · plate TBD (${vinHint})`
  return `${ctx.vehicleLabel} · plate confirm with driver`
}

function vehicleTypeLength(ctx: BookingDraftContext): string {
  const bits = ["Car"]
  if (ctx.vehicleFuel) bits.push(ctx.vehicleFuel)
  if (ctx.vehicleYear) bits.push(String(ctx.vehicleYear))
  bits.push("length confirm at booking")
  return bits.join(" · ")
}

/** Ferry / Finnlines draft — DE→FI Travemünde → Helsinki (Vuosaari). */
export function buildFerryBookingDraft(
  entry: TripCatalogEntry,
  ctx: BookingDraftContext,
): OpsBookingField[] {
  const withHotel = entry.kind === "ferry_hotel"
  const driver = ctx.driverName?.trim() || "Confirm with driver"
  const schedule = ctx.sailingAnchorIso
    ? resolveFerrySchedule(entry, ctx.sailingAnchorIso, ctx.zone, ctx.promiseStartIso)
    : null
  const fields: OpsBookingField[] = [
    field("driverPassengerName", "Driver / passenger name", driver, "Order · assigned driver", {
      placeholder: "As on ID",
    }),
    field("vehicle", "Vehicle", vehicleLine(ctx), "Order · vehicle record"),
    field("vehicleTypeLength", "Vehicle type / length", vehicleTypeLength(ctx), "Order · fuel/year; length not on file"),
    field(
      "route",
      "Route",
      "Travemünde → Helsinki (Vuosaari)",
      "Finnlines DE→FI corridor (mandatory sea leg)",
    ),
    field(
      "sailing",
      "Sailing",
      schedule?.sailingPrefill ?? `${entry.lineName} · Travemünde → Vuosaari`,
      "Sold-out day + sail offset · ~30 h sea (dates only)",
    ),
    field("cabin", "Cabin", "Driver cabin (rest on board)", "Demo default · confirm on Finnlines"),
  ]
  if (withHotel) {
    fields.push(
      field(
        "hotelNight",
        "Travemünde hotel (driver rest)",
        schedule?.hotelPrefill
          ?? `${entry.hotelName ?? "Terminal hotel"} · rest nights before sailing`,
        "Nights waiting in Travemünde before sailing",
      ),
    )
  }
  fields.push(
    field("price", "Price (estimate)", entry.priceLabel, "search_trips synthetic estimate", {
      required: false,
    }),
  )
  if (ctx.driverPhone) {
    fields.push(field("driverPhone", "Driver phone", ctx.driverPhone, "Driver record / chat", { required: false }))
  } else {
    fields.push(
      field("driverPhone", "Driver phone", "Confirm via driver chat", "Not on file — ops confirms with driver", {
        required: false,
        placeholder: "+49 …",
      }),
    )
  }
  return fields
}

/** Tow / roadside draft — contact is always the driver, never the paying customer. */
export function buildTowBookingDraft(
  entry: TripCatalogEntry,
  ctx: BookingDraftContext,
  destinationTitle: string,
): OpsBookingField[] {
  const driver = ctx.driverName?.trim() || "Confirm with driver"
  const contact = ctx.driverPhone
    ? `${driver} · ${ctx.driverPhone}`
    : `${driver} · confirm via driver chat`
  return [
    field("pickupLocation", "Pickup location", ctx.pickupLocation, "ask_driver / current location"),
    field("vehicle", "Vehicle", vehicleLine(ctx), "Order · vehicle record"),
    field("destination", "Tow destination", destinationTitle, "Chosen recovery option"),
    field("driverContact", "Contact (driver — never customer)", contact, "Assigned driver only"),
    field("price", "Price (estimate)", entry.priceLabel, "search_trips synthetic estimate", {
      required: false,
    }),
  ]
}

/** Plain-text block for clipboard → paste into carrier / roadside site. */
export function formatBookingDraftText(
  title: string,
  orderRef: string,
  fields: OpsBookingField[],
  values: Record<string, string>,
): string {
  const lines = [
    `Bahn booking draft · ${orderRef}`,
    title,
    "—",
    ...fields.map((f) => {
      const value = (values[f.key] ?? f.prefill ?? "").trim() || "(blank)"
      return `${f.label}: ${value}`
    }),
    "—",
    "Prefilled by agent · ops reviews before booking. Agent never contacts the paying customer.",
  ]
  return lines.join("\n")
}

/** True when a stored option still has blank booking fields (pre-draft era). */
export function bookingFieldsNeedPrefill(fields: OpsBookingField[] | undefined): boolean {
  if (!fields?.length) return true
  return fields.every((f) => !f.prefill)
}
