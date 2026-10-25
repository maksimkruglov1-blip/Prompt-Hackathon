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
  summary: string
  components: { label: string; priceLabel: string; timeLabel: string }[]
}

/** Real carrier booking / search landing pages (public marketing URLs). */
export const TRIP_CATALOG: TripCatalogEntry[] = [
  {
    id: "trip-tallink-hel-tra",
    kind: "ferry_hotel",
    lineName: "Tallink Silja",
    title: "Tonight evening · Travemünde corridor via Tallink",
    originHint: "travemunde|rostock|lubeck|germany|leipzig|hamburg",
    destinationHint: "helsinki|vuosaari|finland",
    priceEur: 540,
    priceLabel: "€540",
    etaHours: 8,
    timeLabel: "Depart ~22:00 · ~27 h sea",
    delayLabel: "Delivery +1 day",
    durationLabel: "~27 h",
    departureWindow: "Tonight evening",
    bookUrl: "https://www.tallinksilja.com/",
    hotelName: "Kajuta Inn (mock)",
    hotelPriceEur: 95,
    ferryPriceEur: 445,
    summary: "Tallink Silja vehicle + cabin estimate plus nearby terminal hotel. Ops books on the carrier site.",
    components: [
      { label: "Ferry ticket (cabin + vehicle)", priceLabel: "€445", timeLabel: "Tonight ~22:00" },
      { label: "Hotel · Kajuta Inn", priceLabel: "€95", timeLabel: "Check-in ~20:00" },
    ],
  },
  {
    id: "trip-viking-hel",
    kind: "ferry_hotel",
    lineName: "Viking Line",
    title: "Tomorrow morning · Viking Line Baltic sailing",
    originHint: "travemunde|rostock|stockholm|turku|germany|leipzig",
    destinationHint: "helsinki|finland|vuosaari",
    priceEur: 485,
    priceLabel: "€485",
    etaHours: 14,
    timeLabel: "Depart ~08:30 · ~26 h sea",
    delayLabel: "Delivery +1 day",
    durationLabel: "~26 h",
    departureWindow: "Tomorrow morning",
    bookUrl: "https://www.vikingline.com/",
    hotelName: "Terminal Lodge (mock)",
    hotelPriceEur: 140,
    ferryPriceEur: 345,
    summary: "Viking Line vehicle sailing with overnight lodge. Human opens the book link; agent does not purchase.",
    components: [
      { label: "Ferry ticket (cabin + vehicle)", priceLabel: "€345", timeLabel: "Tomorrow ~08:30" },
      { label: "Hotel · Terminal Lodge", priceLabel: "€140", timeLabel: "Check-in ~22:00" },
    ],
  },
  {
    id: "trip-finnlines-freight",
    kind: "ferry",
    lineName: "Finnlines",
    title: "Tomorrow afternoon · Finnlines freight/vehicle",
    originHint: "travemunde|rostock|germany|leipzig|hamburg",
    destinationHint: "helsinki|vuosaari|finland",
    priceEur: 410,
    priceLabel: "€410",
    etaHours: 20,
    timeLabel: "Depart ~14:00 · ~28 h sea",
    delayLabel: "Delivery +2 days",
    durationLabel: "~28 h",
    departureWindow: "Tomorrow afternoon",
    bookUrl: "https://www.finnlines.com/",
    ferryPriceEur: 410,
    summary: "Finnlines vehicle berth — usually more freight capacity when passenger lines sell out. No hotel in this package.",
    components: [
      { label: "Ferry ticket (cabin + vehicle)", priceLabel: "€410", timeLabel: "Tomorrow ~14:00" },
      { label: "Hotel", priceLabel: "€0", timeLabel: "Not included" },
    ],
  },
  {
    id: "trip-eckero-alt",
    kind: "ferry",
    lineName: "Eckerö Line",
    title: "Next day · Eckerö Line via Tallinn corridor",
    originHint: "tallinn|helsinki|finland|estonia|germany",
    destinationHint: "helsinki|tallinn|finland|estonia",
    priceEur: 220,
    priceLabel: "€220",
    etaHours: 30,
    timeLabel: "Flexible day sailings · ~2–3 h sea (short hop)",
    delayLabel: "Only if routing via Tallinn",
    durationLabel: "~2–3 h sea leg",
    departureWindow: "Next calendar day",
    bookUrl: "https://www.eckeroline.com/",
    ferryPriceEur: 220,
    summary: "Eckerö Line short sea option if the plan reroutes via Tallinn. Ops verifies whether this fits the car’s path.",
    components: [
      { label: "Ferry ticket (vehicle)", priceLabel: "€220", timeLabel: "Day sailing" },
    ],
  },
  {
    id: "trip-tow-dealer",
    kind: "tow",
    lineName: "Roadside tow",
    title: "Tow to dealer / receiving site",
    originHint: "ingolstadt|munich|germany|motorway|a9",
    destinationHint: "hamburg|dealer|germany",
    priceEur: 380,
    priceLabel: "€380",
    etaHours: 4,
    timeLabel: "4 h tow ETA",
    delayLabel: "Delivery tomorrow evening",
    durationLabel: "~4 h to load + transit",
    departureWindow: "As soon as truck available",
    bookUrl: "https://www.adac.de/reise-freizeit/verkehr/panne/",
    summary: "Mock tow package to dealer. Book link opens ADAC roadside info — ops places the real tow booking.",
    components: [
      { label: "Tow truck", priceLabel: "€310", timeLabel: "4 h ETA" },
      { label: "Driver waiting stipend", priceLabel: "€45", timeLabel: "Until loaded" },
      { label: "Service-area fee", priceLabel: "€25", timeLabel: "Mock" },
    ],
  },
  {
    id: "trip-tow-workshop",
    kind: "tow",
    lineName: "Roadside tow",
    title: "Tow to nearby workshop",
    originHint: "ingolstadt|munich|germany|motorway|a9",
    destinationHint: "workshop|garage|ingolstadt",
    priceEur: 290,
    priceLabel: "€290",
    etaHours: 2.5,
    timeLabel: "2.5 h tow ETA",
    delayLabel: "Delivery +1–2 days",
    durationLabel: "~2.5 h to workshop",
    departureWindow: "As soon as truck available",
    bookUrl: "https://www.adac.de/reise-freizeit/verkehr/panne/",
    summary: "Mock tow to a nearby workshop. Human books via roadside provider; agent does not purchase.",
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

function scoreEntry(entry: TripCatalogEntry, args: TripSearchArgs): number {
  const origin = args.origin.toLowerCase()
  const destination = args.destination.toLowerCase()
  let score = 0
  for (const token of entry.originHint.split("|")) {
    if (token && origin.includes(token)) score += 2
  }
  for (const token of entry.destinationHint.split("|")) {
    if (token && destination.includes(token)) score += 2
  }
  if (args.prefer === "ferry" && (entry.kind === "ferry" || entry.kind === "ferry_hotel")) score += 5
  if (args.prefer === "tow" && entry.kind === "tow") score += 5
  if (args.prefer === "any") score += 1
  // Prefer main Baltic DE→FI lines for the hackathon ferry demo
  if (/helsinki|finland|vuosaari/.test(destination) && /finnlines|tallink|viking/i.test(entry.lineName)) score += 3
  return score
}

export function searchTripCatalog(args: TripSearchArgs): TripCatalogEntry[] {
  const prefer = args.prefer ?? "any"
  const ranked = [...TRIP_CATALOG]
    .map((entry) => ({ entry, score: scoreEntry(entry, { ...args, prefer }) }))
    .filter((row) => {
      if (prefer === "ferry") return row.entry.kind === "ferry" || row.entry.kind === "ferry_hotel"
      if (prefer === "tow") return row.entry.kind === "tow"
      return true
    })
    .sort((a, b) => b.score - a.score || a.entry.priceEur - b.entry.priceEur)

  const picked = ranked.slice(0, 4).map((row) => row.entry)
  // Always return at least 2 ferry options for Baltic demos
  if (picked.length < 2 && prefer !== "tow") {
    return TRIP_CATALOG.filter((e) => e.kind === "ferry" || e.kind === "ferry_hotel").slice(0, 3)
  }
  return picked.length ? picked : TRIP_CATALOG.slice(0, 3)
}
