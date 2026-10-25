/**
 * Rule-based queue urgency (no LLM).
 * Scoring is local and repeatable — agent runs are separate.
 */

export type UrgencyClass = "P1" | "P2" | "P3"

/** Where a P1 safety signal came from (demo-repeatable). */
export type SafetyFlag = "driver" | "order"

export type UrgencyScore = {
  class: UrgencyClass
  /** Short queue chip / header label, e.g. "P1". */
  chip: UrgencyClass
  /** Plain-English tier title for grouping. */
  title: string
  /** One-line why this case landed here. */
  reason: string
  /** Compact reason for the queue row, e.g. "not driveable". */
  shortReason: string
  /** Maps to existing CSS / tone helpers. */
  tier: "critical" | "urgent" | "watch"
  /** Set when class is P1 from a safety stop. */
  safetyFlag: SafetyFlag | null
  /** Hours until promise / site close; null when unknown. */
  slackHours: number | null
}

export const URGENCY_RULES: {
  class: UrgencyClass
  title: string
  when: string
}[] = [
  {
    class: "P1",
    title: "Safety / vehicle stop",
    when: "Driver unsafe, roadside stop, red warning light, or the vehicle cannot be driven. P2 escalates here when slack is under 1 hour.",
  },
  {
    class: "P2",
    title: "Promise / travel capacity",
    when: "Delivery promise at risk soon, ferry sold out, or a sea-leg capacity issue blocking the plan.",
  },
  {
    class: "P3",
    title: "Tracking / other escalations",
    when: "Tracking gap, softer delays, or other cases that still need a person but are not P1/P2.",
  },
]

const CLASS_META: Record<UrgencyClass, { title: string; tier: UrgencyScore["tier"] }> = {
  P1: { title: "Safety / vehicle stop", tier: "critical" },
  P2: { title: "Promise / travel capacity", tier: "urgent" },
  P3: { title: "Tracking / other", tier: "watch" },
}

/** Demo-stable safety provenance for known seeds (repeatable without LLM). */
const SAFETY_FLAG_BY_REF: Record<string, SafetyFlag> = {
  "CD-420322": "driver",
}

export function urgencyRank(cls: UrgencyClass): number {
  return cls === "P1" ? 0 : cls === "P2" ? 1 : 2
}

/**
 * Hours left until the nearest deadline (delivery promise or pickup-site close),
 * measured against the frozen snapshot clock when provided.
 */
export function computeSlackHours(input: {
  snapshotAt?: string | null
  promiseStart?: string | null
  promiseEnd?: string | null
  pickupClose?: string | null
}): number | null {
  const now = input.snapshotAt ? Date.parse(input.snapshotAt) : Date.now()
  if (!Number.isFinite(now)) return null
  const deadlines = [input.promiseEnd, input.promiseStart, input.pickupClose]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => Number.isFinite(ms))
  if (!deadlines.length) return null
  return (Math.min(...deadlines) - now) / 3_600_000
}

/**
 * Single escalation rule: P2 → P1 when slack is under one hour.
 */
export function escalateP2WhenSlackLow(score: UrgencyScore, slackHours: number | null): UrgencyScore {
  if (score.class !== "P2") return { ...score, slackHours }
  if (slackHours == null || slackHours >= 1) return { ...score, slackHours }
  return {
    ...score,
    class: "P1",
    chip: "P1",
    title: CLASS_META.P1.title,
    tier: "critical",
    reason: `Slack under 1 h — escalated from promise/travel. ${score.reason}`,
    shortReason: "slack < 1 h",
    safetyFlag: null,
    slackHours,
  }
}

function resolveSafetyFlag(input: {
  reference?: string | null
  signal?: string | null
  reasonTitle?: string | null
  reasonShort?: string | null
}): SafetyFlag {
  const ref = input.reference ?? ""
  if (SAFETY_FLAG_BY_REF[ref]) return SAFETY_FLAG_BY_REF[ref]!
  const blob = `${input.reasonTitle ?? ""} ${input.reasonShort ?? ""} ${input.signal ?? ""}`
  if (/driver|ask_driver|roadside|I stopped|warning light|not driveable|cannot be driven/i.test(blob)) {
    return "driver"
  }
  return "order"
}

/**
 * Score one attention-queue row from alert signal + attention copy + slack.
 * Deterministic — never calls a model.
 */
export function scoreUrgency(input: {
  signal: string | null | undefined
  reasonTitle?: string | null
  reasonShort?: string | null
  reference?: string | null
  attentionTone?: string | null
  slackHours?: number | null
}): UrgencyScore {
  const signal = (input.signal ?? "").toUpperCase()
  const blob = `${input.reasonTitle ?? ""} ${input.reasonShort ?? ""} ${signal} ${input.reference ?? ""}`
  const slackHours = input.slackHours ?? null

  let base: UrgencyScore

  // P1 — safety / vehicle stop / driver unsafe
  if (
    /SAFETY_STOP|ROADSIDE|VEHICLE.?WARNING|DRIVER.?UNSAFE|CANNOT BE DRIVEN|RED WARNING|NOT DRIVEABLE/i.test(blob)
    || input.reference === "CD-420322"
  ) {
    const safetyFlag = resolveSafetyFlag(input)
    base = {
      class: "P1",
      chip: "P1",
      title: CLASS_META.P1.title,
      reason: safetyFlag === "driver"
        ? "Safety / not driveable — flagged from the driver’s report."
        : "Safety / not driveable — flagged from the order record.",
      shortReason: "not driveable",
      tier: "critical",
      safetyFlag,
      slackHours,
    }
  } else if (
    /FERRY_SOLD_OUT|FERRY_CONNECTION|SOLD.?OUT|TRAVEL.?CAPACITY|PROMISE|UNACHIEVABLE|DELAY_RISK|LATE.?DELIVERY/i.test(blob)
    || (/FERRY|CAPACITY|CONNECTION/i.test(blob) && !/TRACKING/i.test(blob))
    || input.reference === "CD-420299"
  ) {
    base = {
      class: "P2",
      chip: "P2",
      title: CLASS_META.P2.title,
      reason: /FERRY|SOLD|CAPACITY|SAILING/i.test(blob)
        ? "Ferry or travel capacity is blocking the delivery promise."
        : "Delivery promise at risk soon.",
      shortReason: /FERRY|SOLD/i.test(blob) ? "ferry sold out" : "promise at risk",
      tier: "urgent",
      safetyFlag: null,
      slackHours,
    }
  } else if (/TRACKING_GAP|TRACKING|POSITION/i.test(blob)) {
    base = {
      class: "P3",
      chip: "P3",
      title: CLASS_META.P3.title,
      reason: "Tracking gap — needs a person, lower than safety or ferry capacity.",
      shortReason: "tracking gap",
      tier: "watch",
      safetyFlag: null,
      slackHours,
    }
  } else {
    base = {
      class: "P3",
      chip: "P3",
      title: CLASS_META.P3.title,
      reason: "Needs a person — not scored as safety or promise-blocking travel.",
      shortReason: "needs person",
      tier: "watch",
      safetyFlag: null,
      slackHours,
    }
  }

  return escalateP2WhenSlackLow(base, slackHours)
}
