// Shared types for the on-the-road agent and control-room decision cards.

export type AgentFact = {
  label: string
  value: string
  source: string
  sourceKind: "alert" | "message" | "order" | "driver" | "vehicle" | "tool" | "site"
}

export type AgentAction = {
  tool: string
  summary: string
  at: string
  detail?: string | null
}

/** Booking-draft field: agent prefills from order/driver/option; ops reviews before booking. */
export type OpsBookingField = {
  key: string
  label: string
  placeholder: string
  required: boolean
  /** Source hint (order, driver, search_trips) — never a paying-customer contact. */
  reason: string
  /** Agent-proposed value for ops to edit. */
  prefill?: string | null
}

export type DecisionOption = {
  id: string
  title: string
  summary: string
  /** Absolute recovery / booking cost in euros (primary scannable signal). */
  priceEur: number
  /** Display form, e.g. "€380". */
  priceLabel: string
  /** Hours until the next concrete step (tow ETA, sailing, etc.), when known. */
  etaHours: number | null
  /** Primary time signal for the card, e.g. "4 h tow ETA". */
  timeLabel: string
  /** Delivery-promise impact, e.g. "Delivery tomorrow evening". */
  delayLabel: string
  /** What ops still needs to do if this option is chosen. */
  opsNext: string
  /** Extra cost / delay / customer-impact notes (secondary to price/time). */
  implications: string
  /** Actions that require human approval before the agent may execute them. */
  requiresApproval: string[]
  /** recovery | ferry | hotel | ferry_hotel — drives UI chips. */
  kind?: "recovery" | "ferry" | "hotel" | "ferry_hotel"
  /** Synthetic ferry carrier / line name — shown prominently for ferry packages. */
  lineName?: string
  /** Optional price/time breakdown (ferry leg, hotel night, …). */
  components?: { label: string; priceLabel: string; timeLabel: string }[]
  /** Fields ops must fill after Approve; agent leaves these blank. */
  bookingFields?: OpsBookingField[]
  /**
   * Public carrier / roadside booking entry URL from search_trips.
   * Ops opens this in a new tab — the agent never books.
   */
  bookUrl?: string
  /**
   * Scannable tradeoff vs the primary plan (e.g. hotel bridge vs next daily sailing).
   */
  verdict?: string | null
  /** Calendar arrival at delivery city, e.g. "28 Oct". */
  arrivalLabel?: string | null
}

export type DecisionStatus = "pending" | "approved" | "changed" | "dismissed"

/** Promised vs current outlook — shown under the problem headline. */
export type DeliveryTiming = {
  /** From CUSTOMER_DELIVERY_PROMISE when available. */
  promisedLabel: string
  /** Mocked outlook after this incident (before ops picks an option). */
  expectedLabel: string
  /** Short delta, e.g. "+1 day vs promise" or "Late · promise at risk". */
  impactLabel: string
  tone: "danger" | "warn" | "neutral"
}

/** Which decision step the card is on — recover first, travel/ferry only when needed. */
export type DecisionStage = "recover" | "travel"

/** Compact delivery-chain step on the decision card. */
export type JourneyLegKind = "pickup" | "drive" | "ferry" | "handover"
export type JourneyLegState = "done" | "current" | "blocked" | "upcoming"

export type DeliveryJourneyLeg = {
  id: string
  kind: JourneyLegKind
  label: string
  detail: string | null
  note: string | null
  state: JourneyLegState
  tone: "danger" | "warn" | "accent" | "ok" | "neutral"
}

export type DeliveryJourneyBranch = {
  id: string
  label: string
  detail: string
  note: string | null
}

export type DeliveryJourney = {
  legs: DeliveryJourneyLeg[]
  bottleneck: string | null
  /** Reserved; DE→FI keeps this null — Finnlines sea leg is mandatory (no land substitute). */
  branch: DeliveryJourneyBranch | null
  source: string
}

/** Ops-facing driver chat on the decision card (never the paying customer). */
export type DriverChatRole = "driver" | "ops" | "agent"

export type DriverChatMessage = {
  id: string
  role: DriverChatRole
  roleLabel: string
  body: string
  at: string
  source: "dataset" | "ask_driver"
}

export type DriverChatThread = {
  driverName: string | null
  subtitle: string
  messages: DriverChatMessage[]
}

/** Absolute dated milestones on the decision card (not relative “ago”). */
export type DeliveryTimelineKind =
  | "pickup"
  | "drive"
  | "ferry"
  | "problem"
  | "branch"
  | "delivery"
  | "expected"

export type DeliveryTimelineStep = {
  id: string
  kind: DeliveryTimelineKind
  label: string
  /** Calendar date only, e.g. "27 Oct" (no clock / timezone). */
  whenLabel: string
  whereLabel: string | null
  detail: string | null
  tone: "danger" | "warn" | "ok" | "neutral"
  state: "done" | "current" | "upcoming" | "unknown"
}

export type DeliveryTimeline = {
  /** Shared past → bottleneck → promise (horizontal strip). */
  steps: DeliveryTimelineStep[]
  /** Optional ops note when one leg is the delay bottleneck. */
  bottleneck?: string | null
  /** Promised delivery date (dates only), when known. */
  promisedLabel?: string | null
  source: string
}

export type AgentDecision = {
  summary: string
  /** Short ops headline of what’s wrong (1–2 lines), shown above the options. */
  problem: string
  /** Where the car is now, when known (ops strip under Problem). */
  currentLocation?: string
  /** Promised delivery vs now-expected impact. */
  deliveryTiming: DeliveryTiming
  happened: string
  facts: AgentFact[]
  actions: AgentAction[]
  /** Two or three concrete alternatives for ops (ferry demos use distinct lines). */
  options: DecisionOption[]
  /** Explicit reminder that the agent must not contact the paying customer. */
  customerContact: "blocked"
  recommendationId: string | null
  /**
   * Decision staging: roadside/breakdown → recover (tow where?);
   * ferry sold-out / travel capacity → travel (choose sailing).
   */
  stage?: DecisionStage
  /** UI section title, e.g. "Step 1 · Choose recovery". */
  stageTitle?: string
  /** One-line prompt under the stage title, e.g. "What should we do?". */
  stagePrompt?: string
}

export type AgentRunRecord = {
  id: string
  orderId: string
  status: DecisionStatus
  mode: "mock" | "llm"
  decision: AgentDecision
  selectedOptionId: string | null
  changeNote: string | null
  /** Ops-entered booking/contact details after Approve (never filled by the agent). */
  opsDetails: Record<string, string> | null
  createdAt: string
  updatedAt: string
  toolTrace: AgentAction[]
}

export type QueueItem = {
  orderId: string
  reference: string
  vehicle: string
  customer: string
  route: string
  reason: string
  reasonTone: "danger" | "warn" | "accent" | "neutral"
  waitingLabel: string
  agentStatus: "idle" | "working" | "ready" | "pending" | "approved" | "changed"
  signal: string | null
  attentionShort: string
  /**
   * Rule-based urgency class (no LLM): P1 safety, P2 promise/ferry, P3 tracking/other.
   * `urgency` kept as critical|urgent|watch for existing CSS stripe helpers.
   */
  urgency: "critical" | "urgent" | "watch"
  urgencyLabel: string
  urgencyClass: "P1" | "P2" | "P3"
  /** Plain-English why this class. */
  urgencyReason: string
  /** Compact queue chip reason, e.g. "not driveable". */
  urgencyShortReason: string
  /** P1 provenance: driver report vs order record. */
  safetyFlag: "driver" | "order" | null
  /** Hours until promise / site close; used for sort + P2→P1 escalation. */
  slackHours: number | null
  /** ISO timestamp when attention was raised — oldest wins ties after slack. */
  raisedAt: string | null
  /** Short delivery-process stage chip (not GPS). */
  deliveryStage: string
  deliveryStageKnown: boolean
}
