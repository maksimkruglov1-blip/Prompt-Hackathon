/** Curated Baltic ferry + recovery catalog with real public booking entry URLs.
 * Prices/times are synthetic estimates for the demo. The agent never books —
 * ops opens bookUrl and completes the purchase. */

export type TripCatalogEntry = {
  id: string
  kind: "ferry" | "ferry_hotel" | "tow"
  lineName: string
  title: string
  originHint: string
  destinationHint: string
  priceEur: number
  priceLabel: string
  etaHours: number | null
  timeLabel: string
  delayLabel: string
  durationLabel: string
  departureWindow: string
  bookUrl: string
  hotelName?: string
  hotelPriceEur?: number
  ferryPriceEur?: number
  /** Drive leg cost for land+sea reroutes (synthetic). */
  drivePriceEur?: number
  summary: string
  /** Tradeoff vs waiting for next primary sailing. */
  verdict?: string
  components: { label: string; priceLabel: string; timeLabel: string }[]
}

/**
 * Real DE→FI vehicle corridor: Finnlines Travemünde/Rostock ↔ Helsinki Vuosaari.
 * Ships Finnstar, Finnmaid, Finnlady — roughly once per day, ~27–30 h sea.
 * Tallink Silja / Viking Line are NOT the primary car corridor for Germany→Finland.
 * Prices are synthetic demo estimates; bookUrl is the real Finnlines site.
 */
export const TRIP_CATALOG: TripCatalogEntry[] = [
  {
    id: "trip-finnstar",
    kind: "ferry",
    lineName: "Finnlines · Finnstar",
    title: "Tonight · Finnstar · Travemünde → Vuosaari",
    originHint: "travemunde|travemünde|rostock|lubeck|leipzig|germany|baltic|ferry corridor",
    destinationHint: "helsinki|vuosaari|finland",
    priceEur: 445,
    priceLabel: "€445",
    etaHours: 10,
    timeLabel: "Daily ~22:00 · ~29 h sea",
    delayLabel: "Delivery +1 day",
    durationLabel: "~29 h",
    departureWindow: "Tonight (once daily)",
    bookUrl: "https://www.finnlines.com/",
    ferryPriceEur: 445,
    summary: "Finnlines Finnstar — Travemünde ↔ Helsinki Vuosaari vehicle sailing. Primary DE→FI freight/passenger corridor; roughly one departure per day.",
    components: [
      { label: "Finnstar · vehicle + cabin", priceLabel: "€445", timeLabel: "Tonight ~22:00 · ~29 h" },
    ],
  },
  {
    id: "trip-finnmaid",
    kind: "ferry",
    lineName: "Finnlines · Finnmaid",
    title: "Tomorrow · Finnmaid · Travemünde → Vuosaari",
    originHint: "travemunde|travemünde|rostock|lubeck|leipzig|germany|baltic|ferry corridor",
    destinationHint: "helsinki|vuosaari|finland",
    priceEur: 420,
    priceLabel: "€420",
    etaHours: 26,
    timeLabel: "Daily ~21:00 · ~28 h sea",
    delayLabel: "Delivery +2 days",
    durationLabel: "~28 h",
    departureWindow: "Tomorrow (once daily)",
    bookUrl: "https://www.finnlines.com/",
    ferryPriceEur: 420,
    summary: "Finnlines Finnmaid — next daily Travemünde → Vuosaari sailing after Finnstar. Same corridor, synthetic demo price.",
    components: [
      { label: "Finnmaid · vehicle + cabin", priceLabel: "€420", timeLabel: "Tomorrow ~21:00 · ~28 h" },
    ],
  },
  {
    id: "trip-finnlady",
    kind: "ferry_hotel",
    lineName: "Finnlines · Finnlady",
    title: "Next sailing + Travemünde hotel (driver rest)",
    originHint: "travemunde|travemünde|rostock|lubeck|leipzig|germany|baltic|ferry corridor|sold.?out",
    destinationHint: "helsinki|vuosaari|finland",
    priceEur: 515,
    priceLabel: "€515",
    etaHours: 40,
    timeLabel: "Daily ~22:00 · ~30 h sea",
    delayLabel: "Delivery +2 days · hotel bridge",
    durationLabel: "~30 h sea + hotel",
    departureWindow: "Day after tomorrow (once daily)",
    bookUrl: "https://www.finnlines.com/",
    hotelName: "Kajuta Inn (mock)",
    hotelPriceEur: 95,
    ferryPriceEur: 420,
    summary: "Tonight sold out — Finnlines sea leg is still required. Keep the driver on rest at Travemünde, then sail Finnlady (next daily ship). Long extra driving is blocked by rest hours.",
    components: [
      { label: "Finnlady · vehicle + cabin", priceLabel: "€420", timeLabel: "Day+2 ~22:00 · ~30 h" },
      { label: "Hotel · Kajuta Inn Travemünde (mock)", priceLabel: "€95", timeLabel: "Driver rest before sailing" },
    ],
  },
  {
    id: "trip-tow-dealer",
    kind: "tow",
    lineName: "Roadside assistance",
    title: "Tow to dealer / receiving site",
    originHint: "ingolstadt|munich|germany|motorway|a9",
    destinationHint: "hamburg|dealer|germany",
    priceEur: 380,
    priceLabel: "€380",
    etaHours: 4,
    timeLabel: "Tow ~4 h",
    delayLabel: "Delivery tomorrow evening",
    durationLabel: "~4 h to load + transit",
    departureWindow: "As soon as truck available",
    bookUrl: "https://www.adac.de/hilfe/",
    summary: "Mock tow package to the dealer / receiving site. Book opens ADAC help / roadside-assistance info.",
    components: [
      { label: "Tow truck", priceLabel: "€310", timeLabel: "4 h ETA" },
      { label: "Driver waiting stipend", priceLabel: "€45", timeLabel: "Until loaded" },
      { label: "Service-area fee", priceLabel: "€25", timeLabel: "Mock" },
    ],
  },
  {
    id: "trip-tow-workshop",
    kind: "tow",
    lineName: "Roadside assistance",
    title: "Tow to nearby workshop",
    originHint: "ingolstadt|munich|germany|motorway|a9",
    destinationHint: "workshop|garage|ingolstadt",
    priceEur: 290,
    priceLabel: "€290",
    etaHours: 2.5,
    timeLabel: "Tow ~2.5 h",
    delayLabel: "Delivery +1–2 days",
    durationLabel: "~2.5 h to workshop",
    departureWindow: "As soon as truck available",
    bookUrl: "https://www.adac.de/hilfe/",
    summary: "Mock tow to a nearby workshop. Book opens ADAC help / roadside-assistance info.",
    components: [
      { label: "Tow truck", priceLabel: "€240", timeLabel: "2.5 h ETA" },
      { label: "Workshop intake hold", priceLabel: "€35", timeLabel: "Mock" },
      { label: "Driver waiting stipend", priceLabel: "€15", timeLabel: "Short handoff" },
    ],
  },
]

export type TripSearchArgs = {
  origin: string
  destination: string
  prefer?: "ferry" | "tow" | "any"
  earliestDeparture?: string
  vehicleNote?: string
}

const BALTIC_SEA_ORIGIN = /travemunde|travemünde|rostock|lubeck|lübeck|stockholm|turku|tallinn|helsinki|vuosaari|baltic|ferry/
const BALTIC_SEA_DEST = /helsinki|vuosaari|finland|tallinn|estonia|stockholm|turku/
const COUNTRY_TOKEN = /\b(germany|deutschland|de|finland|suomi|fi|estonia|ee|sweden|se|denmark|dk)\b/i

/** ISO-ish country from free text ("Munich, DE" / "Helsinki, Finland"). */
export function inferCountryCode(text: string): string | null {
  const lower = text.toLowerCase()
  if (/\b(finland|suomi|\bfi\b)\b/.test(lower) || /helsinki|vuosaari|turku/.test(lower)) return "FI"
  if (/\b(estonia|\bee\b)\b/.test(lower) || /tallinn/.test(lower)) return "EE"
  if (/\b(sweden|\bse\b)\b/.test(lower) || /stockholm/.test(lower)) return "SE"
  if (/\b(germany|deutschland|\bde\b)\b/.test(lower) || /munich|münchen|hamburg|leipzig|ingolstadt|berlin|rostock|travemunde|travemünde/.test(lower)) return "DE"
  const m = text.match(/,\s*([A-Z]{2})\s*$/)
  return m ? m[1] : null
}

/**
 * True when the search looks like a Baltic sea crossing (DE/SE ports → FI/EE),
 * not a generic inland Germany trip that merely mentioned "Germany".
 */
export function needsSeaCrossing(args: Pick<TripSearchArgs, "origin" | "destination" | "prefer" | "vehicleNote">): boolean {
  if (args.prefer === "tow") return false
  const origin = args.origin.toLowerCase()
  const destination = args.destination.toLowerCase()
  const note = (args.vehicleNote ?? "").toLowerCase()
  if (/tow|roadside|cannot be driven|warning light|breakdown/.test(note)) return false

  const from = inferCountryCode(args.origin)
  const to = inferCountryCode(args.destination)
  // Same-country inland (e.g. Munich → Hamburg) never needs a Baltic ferry.
  if (from && to && from === to) return false

  const seaOrigin = BALTIC_SEA_ORIGIN.test(origin) || /leipzig/.test(origin)
  const seaDest = BALTIC_SEA_DEST.test(destination)
  if (seaOrigin && seaDest) return true
  if (args.prefer === "ferry" && seaDest) return true
  if (from === "DE" && (to === "FI" || to === "EE")) return true
  return false
}

/** Inland / roadside searches should never surface Tallink etc. */
export function shouldPreferTow(args: Pick<TripSearchArgs, "origin" | "destination" | "prefer" | "vehicleNote">): boolean {
  if (args.prefer === "tow") return true
  if (args.prefer === "ferry" && needsSeaCrossing(args)) return false
  const note = (args.vehicleNote ?? "").toLowerCase()
  if (/tow|roadside|cannot be driven|warning light|breakdown|safety/.test(note)) return true
  const from = inferCountryCode(args.origin)
  const to = inferCountryCode(args.destination)
  if (from && to && from === to) return true
  return !needsSeaCrossing(args) && args.prefer !== "ferry"
}

function hintHit(hint: string, haystack: string): boolean {
  return hint.split("|").some((token) => {
    const t = token.trim().toLowerCase()
    if (!t) return false
    // Never treat bare country names as a ferry corridor match.
    if (COUNTRY_TOKEN.test(t) && t.length <= 11) return false
    return haystack.includes(t)
  })
}

function scoreEntry(entry: TripCatalogEntry, args: TripSearchArgs, sea: boolean): number {
  const origin = args.origin.toLowerCase()
  const destination = args.destination.toLowerCase()
  let score = 0
  if (hintHit(entry.originHint, origin)) score += 3
  if (hintHit(entry.destinationHint, destination)) score += 3
  if (args.prefer === "ferry" && (entry.kind === "ferry" || entry.kind === "ferry_hotel")) score += 5
  if (args.prefer === "tow" && entry.kind === "tow") score += 5
  if (sea && (entry.kind === "ferry" || entry.kind === "ferry_hotel") && /helsinki|finland|vuosaari|leipzig|germany|travemunde|rostock/.test(`${origin} ${destination}`)) {
    // Primary DE→FI car corridor is Finnlines (Finnstar / Finnmaid / Finnlady).
    if (/finnstar/i.test(`${entry.lineName} ${entry.id}`)) score += 12
    else if (/finnmaid/i.test(`${entry.lineName} ${entry.id}`)) score += 11
    else if (/finnlady/i.test(`${entry.lineName} ${entry.id}`)) score += 10
    else if (/finnlines/i.test(entry.lineName)) score += 8
    // Never offer Tallinn drive / Eckerö / Tallink / Viking as a DE→FI substitute (driver rest).
    if (/tallinn-reroute|drive to tallinn|drive \+ tallinn/i.test(`${entry.id} ${entry.lineName} ${entry.title}`)) score -= 100
    if (/eckerö|eckero|tallink|viking/i.test(entry.lineName)) score -= 50
  }
  if (!sea && entry.kind === "tow") score += 4
  // Strongly reject ferries when this is not a sea corridor.
  if (!sea && (entry.kind === "ferry" || entry.kind === "ferry_hotel")) score -= 100
  return score
}

export function searchTripCatalog(args: TripSearchArgs): TripCatalogEntry[] {
  const sea = needsSeaCrossing(args)
  const forceTow = shouldPreferTow(args)
  const prefer: NonNullable<TripSearchArgs["prefer"]> = forceTow
    ? "tow"
    : args.prefer === "ferry" && sea
      ? "ferry"
      : (args.prefer ?? (sea ? "ferry" : "tow"))

  const ranked = [...TRIP_CATALOG]
    .map((entry) => ({ entry, score: scoreEntry(entry, { ...args, prefer }, sea) }))
    .filter((row) => {
      if (row.score <= 0) return false
      if (prefer === "ferry") return row.entry.kind === "ferry" || row.entry.kind === "ferry_hotel"
      if (prefer === "tow") return row.entry.kind === "tow"
      // "any" still hides ferries unless this is a real sea corridor.
      if (!sea && (row.entry.kind === "ferry" || row.entry.kind === "ferry_hotel")) return false
      return true
    })
    .sort((a, b) => b.score - a.score || a.entry.priceEur - b.entry.priceEur)

  const picked = ranked.slice(0, 3).map((row) => row.entry)
  if (picked.length >= 2) return picked

  if (prefer === "tow" || forceTow || !sea) {
    return TRIP_CATALOG.filter((e) => e.kind === "tow").slice(0, 2)
  }
  // DE→FI fallback: the three Finnlines ships only (not Tallink/Viking/Eckerö).
  return TRIP_CATALOG.filter((e) => /finnstar|finnmaid|finnlady/i.test(e.id)).slice(0, 3)
}
