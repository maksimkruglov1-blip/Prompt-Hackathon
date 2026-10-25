/**
 * Single source for DE→FI Finnlines sailing → arrival dates (dates only, no clocks).
 * ~30 h Travemünde → Vuosaari ≈ +2 calendar days from sailing day to delivery readiness.
 */

import { fmtDay } from "@/lib/present/time"
import type { TripCatalogEntry } from "./trip-catalog"

/** Calendar days from sailing departure to delivery-ready after ~30 h sea + short final leg. */
export const FERRY_SEA_ARRIVAL_DAYS = 2

export function shiftIsoDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

/**
 * Days after the sold-out / timeline ferry day until this ship sails.
 * Finnlady waits longer (rest nights) so sail + 30 h lands +1 vs a typical promise.
 */
export function ferrySailOffsetDays(entry: { id: string; departureWindow?: string }): number {
  if (/finnlady/i.test(entry.id) || /day after tomorrow/i.test(entry.departureWindow ?? "")) return 3
  if (/finnmaid/i.test(entry.id) || /\btomorrow\b/i.test(entry.departureWindow ?? "")) return 1
  if (/finnstar/i.test(entry.id) || /tonight|\btoday\b/i.test(entry.departureWindow ?? "")) return 0
  return 0
}

function startOfUtcDay(iso: string): number {
  const d = new Date(iso)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Whole calendar days from promise start to arrival (negative = early). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  return Math.round((startOfUtcDay(toIso) - startOfUtcDay(fromIso)) / 86_400_000)
}

export type FerrySchedule = {
  sailIso: string
  sailLabel: string
  arriveIso: string
  arriveLabel: string
  delayDays: number
  delayLabel: string
  hotelNights: number
  hotelFromLabel: string | null
  hotelToLabel: string | null
  hotelPrefill: string | null
  sailingPrefill: string
}

export function resolveFerrySchedule(
  entry: TripCatalogEntry,
  anchorIso: string,
  zone: string | null,
  promiseStart: string | null,
): FerrySchedule {
  const sailOffset = ferrySailOffsetDays(entry)
  const sailIso = shiftIsoDays(anchorIso, sailOffset)
  const arriveIso = shiftIsoDays(sailIso, FERRY_SEA_ARRIVAL_DAYS)
  const sailLabel = fmtDay(sailIso, zone) || "—"
  const arriveLabel = fmtDay(arriveIso, zone) || "—"
  const delayDays = promiseStart ? calendarDaysBetween(promiseStart, arriveIso) : sailOffset > 0 ? 1 : 0
  const delayLabel =
    delayDays === 0
      ? "On promise"
      : delayDays > 0
        ? `Delivery +${delayDays} day${delayDays === 1 ? "" : "s"} vs promise`
        : `Delivery ${Math.abs(delayDays)} day${Math.abs(delayDays) === 1 ? "" : "s"} early`

  const withHotel = entry.kind === "ferry_hotel" && sailOffset > 0
  const hotelNights = withHotel ? sailOffset : 0
  const hotelFromLabel = withHotel ? (fmtDay(anchorIso, zone) || null) : null
  const hotelToIso = withHotel ? shiftIsoDays(anchorIso, sailOffset - 1) : null
  const hotelToLabel = hotelToIso ? (fmtDay(hotelToIso, zone) || null) : null
  const hotelName = entry.hotelName ?? "Terminal hotel"
  const hotelPrefill = withHotel && hotelFromLabel && hotelToLabel
    ? hotelFromLabel === hotelToLabel
      ? `${hotelName} · ${hotelFromLabel} (1 night · driver rest)`
      : `${hotelName} · ${hotelFromLabel}–${hotelToLabel} (${hotelNights} nights · driver rest)`
    : null

  return {
    sailIso,
    sailLabel,
    arriveIso,
    arriveLabel,
    delayDays,
    delayLabel,
    hotelNights,
    hotelFromLabel,
    hotelToLabel,
    hotelPrefill,
    sailingPrefill: `${entry.lineName} · ${sailLabel}, Travemünde → Vuosaari`,
  }
}
