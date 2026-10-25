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

/** Contact / booking fields the agent cannot fill — ops completes after Approve. */
export type OpsBookingField = {
  key: string
  label: string
  placeholder: string
  required: boolean
  /** Why this is blank (agent never contacts the paying customer). */
  reason: string
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
  agentStatus: "idle" | "ready" | "pending" | "approved" | "changed"
  signal: string | null
  attentionShort: string
}
