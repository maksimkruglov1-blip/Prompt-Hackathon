"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import type { AgentRunRecord, QueueItem } from "@/lib/agent/types"
import { AppFrame } from "../app-frame"

type QueueResponse = {
  snapshotAt: string | null
  mode: "mock" | "llm"
  items: QueueItem[]
  error?: string
}

type DecisionResponse = {
  orderId: string
  reference: string
  vehicle: string
  customer: string
  route: string
  lane: string
  onRoad: boolean
  mode: "mock" | "llm"
  run: AgentRunRecord | null
  alerts: { id: string; signal: string; severity: string; status: string; summary: string }[]
  attention: { title: string; detail: string | null; tone: string; short: string }[]
  error?: string
}

const STATUS_LABEL: Record<QueueItem["agentStatus"], string> = {
  idle: "No agent",
  ready: "Ready",
  pending: "Needs decision",
  approved: "Approved",
  changed: "Changed",
}

export function ControlRoom() {
  const [queue, setQueue] = useState<QueueResponse | null>(null)
  const [error, setError] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [decision, setDecision] = useState<DecisionResponse | null>(null)
  const [loadingDecision, setLoadingDecision] = useState(false)
  const [busy, setBusy] = useState(false)
  const [changeNote, setChangeNote] = useState("")
  const [pickedOption, setPickedOption] = useState<string | null>(null)
  const [showChange, setShowChange] = useState(false)
  const [bookingForm, setBookingForm] = useState<Record<string, string>>({})
  const [bookingSaved, setBookingSaved] = useState(false)

  const loadQueue = useCallback(async () => {
    try {
      const response = await fetch("/api/control-room")
      const data = await response.json() as QueueResponse
      if (!response.ok) throw new Error(data.error || "Could not load the attention queue")
      setQueue(data)
      setError("")
      setSelectedId((current) => {
        if (current && data.items.some((item) => item.orderId === current)) return current
        const ferry = data.items.find((item) => item.reference === "CD-420299")
        const bentley = data.items.find((item) => item.reference === "CD-420322")
        return ferry?.orderId ?? bentley?.orderId ?? data.items[0]?.orderId ?? null
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the attention queue")
    }
  }, [])

  useEffect(() => { void loadQueue() }, [loadQueue])

  useEffect(() => {
    if (!selectedId) {
      setDecision(null)
      return
    }
    const controller = new AbortController()
    setLoadingDecision(true)
    setShowChange(false)
    setChangeNote("")
    setPickedOption(null)
    setBookingForm({})
    setBookingSaved(false)
    fetch(`/api/control-room/${selectedId}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as DecisionResponse
        if (!response.ok) throw new Error(data.error || "Could not load the decision card")
        setDecision(data)
        setPickedOption(data.run?.decision.recommendationId ?? data.run?.decision.options[0]?.id ?? null)
        setBookingForm(data.run?.opsDetails ?? {})
        setBookingSaved(!!data.run?.opsDetails && Object.keys(data.run.opsDetails).length > 0)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setDecision(null)
        setError(cause instanceof Error ? cause.message : "Could not load the decision card")
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingDecision(false) })
    return () => controller.abort()
  }, [selectedId])

  async function runAgent() {
    if (!selectedId) return
    setBusy(true)
    try {
      const response = await fetch(`/api/agent/on-the-road/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      })
      const data = await response.json() as { card?: DecisionResponse; error?: string }
      if (!response.ok) throw new Error(data.error || "Agent failed")
      if (data.card) {
        setDecision(data.card)
        setPickedOption(data.card.run?.decision.recommendationId ?? data.card.run?.decision.options[0]?.id ?? null)
      }
      await loadQueue()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent failed")
    } finally {
      setBusy(false)
    }
  }

  async function decide(status: "approved" | "changed") {
    if (!selectedId) return
    setBusy(true)
    try {
      const response = await fetch(`/api/agent/on-the-road/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "decide",
          status,
          optionId: pickedOption,
          changeNote: changeNote || undefined,
        }),
      })
      const data = await response.json() as { card?: DecisionResponse; error?: string }
      if (!response.ok) throw new Error(data.error || "Could not save the decision")
      if (data.card) {
        setDecision(data.card)
        setBookingForm(data.card.run?.opsDetails ?? {})
        setBookingSaved(false)
      }
      setShowChange(false)
      await loadQueue()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the decision")
    } finally {
      setBusy(false)
    }
  }

  async function saveBookingDetails() {
    if (!selectedId) return
    setBusy(true)
    try {
      const response = await fetch(`/api/agent/on-the-road/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_booking_details", opsDetails: bookingForm }),
      })
      const data = await response.json() as { card?: DecisionResponse; error?: string }
      if (!response.ok) throw new Error(data.error || "Could not save booking contacts")
      if (data.card) {
        setDecision(data.card)
        setBookingForm(data.card.run?.opsDetails ?? bookingForm)
      }
      setBookingSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save booking contacts")
    } finally {
      setBusy(false)
    }
  }

  const run = decision?.run ?? null
  const pending = run?.status === "pending"
  const chosenOption = run?.selectedOptionId
    ? run.decision.options.find((option) => option.id === run.selectedOptionId) ?? null
    : null
  const bookingFields = chosenOption?.bookingFields ?? []

  return (
    <AppFrame section="board" board snapshotAt={queue?.snapshotAt ?? null}>
      <main className="cr-page">
        <header className="cr-head">
          <div>
            <p className="cr-eyebrow">Bahn · Prompt Operations</p>
            <h1>Control Room</h1>
            <p className="cr-sub">
              {queue
                ? <>Only orders that need a person · <b>{queue.items.length}</b> in queue · agent <b>{queue.mode === "llm" ? "LLM" : "mock"}</b></>
                : "Loading attention queue…"}
            </p>
          </div>
          <div className="cr-head-actions">
            <Link className="cr-ghost" href="/lanes">All orders</Link>
            <Link className="cr-ghost" href="/inbox">Inbox</Link>
          </div>
        </header>

        {error && <p className="cr-error" role="alert">{error}</p>}

        <div className="cr-layout">
          <section className="cr-queue" aria-label="Attention queue">
            <header className="cr-pane-head">
              <h2>Attention queue</h2>
              <span className="num">{queue?.items.length ?? "—"}</span>
            </header>
            {!queue && !error && (
              <ul className="cr-queue-list" aria-busy="true">
                {[0, 1, 2, 3].map((i) => <li className="cr-skel" key={i} />)}
              </ul>
            )}
            {queue && queue.items.length === 0 && (
              <p className="cr-empty">No orders waiting on a person. Quiet shift.</p>
            )}
            {queue && queue.items.length > 0 && (
              <ul className="cr-queue-list">
                {queue.items.map((item) => {
                  const active = item.orderId === selectedId
                  return (
                    <li key={item.orderId}>
                      <button
                        type="button"
                        className={`cr-qitem tone-${item.reasonTone}${active ? " active" : ""}`}
                        onClick={() => setSelectedId(item.orderId)}
                        aria-current={active ? "true" : undefined}
                      >
                        <div className="cr-qtop">
                          <span className="cr-qvehicle">{item.vehicle}</span>
                          <span className="cr-qwait num">{item.waitingLabel}</span>
                        </div>
                        <div className="cr-qmeta">
                          <span className="mono">{item.reference}</span>
                          <span>{item.route}</span>
                        </div>
                        <p className="cr-qreason">{item.reason}</p>
                        <div className="cr-qfoot">
                          <span className={`cr-pill status-${item.agentStatus}`}>{STATUS_LABEL[item.agentStatus]}</span>
                          {item.signal && <span className="cr-signal">{item.signal.replaceAll("_", " ")}</span>}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="cr-decision" aria-label="Decision panel">
            {!selectedId && <p className="cr-empty pane">Select an order from the queue.</p>}
            {selectedId && loadingDecision && <div className="cr-decision-skel" aria-busy="true" />}
            {selectedId && !loadingDecision && decision && (
              <>
                <header className="cr-decision-head">
                  <div>
                    <p className="cr-eyebrow">{decision.reference} · {decision.route}</p>
                    <h2>{decision.vehicle}</h2>
                    <p className="cr-customer">
                      {decision.customer}
                      <span> · agent must not contact</span>
                      <span className="cr-mode-pill" title={decision.mode === "llm" ? "OPENAI_API_KEY is set" : "No API key — mock path"}>
                        · agent {run?.mode ?? decision.mode}
                      </span>
                    </p>
                  </div>
                  <div className="cr-decision-tools">
                    <Link className="cr-ghost" href={`/orders/${decision.orderId}`}>Open record</Link>
                    <button type="button" className="cr-secondary" disabled={busy} onClick={() => void runAgent()}>
                      {run ? "Re-run agent" : "Run on-the-road agent"}
                    </button>
                  </div>
                </header>

                {!run && (
                  <div className="cr-callout">
                    <h3>No agent yet</h3>
                    <p>The agent gathers facts from the driver and the record, proposes two options — and never calls the customer.</p>
                    <button type="button" className="cr-primary" disabled={busy} onClick={() => void runAgent()}>
                      Start agent
                    </button>
                  </div>
                )}

                {run && (
                  <div className="cr-sections">
                    <p className="cr-problem" role="status">
                      <span className="cr-problem-label">Problem</span>
                      {run.decision.problem || run.decision.summary || run.decision.happened}
                    </p>

                    {run.decision.deliveryTiming && (
                      <div className={`cr-timing tone-${run.decision.deliveryTiming.tone}`} role="status">
                        <div className="cr-timing-row">
                          <span className="cr-timing-k">Promised</span>
                          <span className="cr-timing-v">{run.decision.deliveryTiming.promisedLabel.replace(/^Promised\s+/i, "")}</span>
                        </div>
                        <div className="cr-timing-row">
                          <span className="cr-timing-k">Now expected</span>
                          <span className="cr-timing-v">{run.decision.deliveryTiming.expectedLabel.replace(/^Now expected\s+/i, "")}</span>
                        </div>
                        <p className="cr-timing-impact">{run.decision.deliveryTiming.impactLabel}</p>
                      </div>
                    )}

                    <section className="cr-block cr-hero-choice">
                      <div className="cr-choice-head">
                        <h3>Choose an option</h3>
                        {run.decision.summary && run.decision.summary !== run.decision.problem && (
                          <p className="cr-choice-sub">{run.decision.summary}</p>
                        )}
                      </div>
                      <div className="cr-options" role="radiogroup" aria-label="Proposed options">
                        {run.decision.options.map((option) => {
                          const selected = pickedOption === option.id
                          const recommended = run.decision.recommendationId === option.id
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={`cr-option${selected ? " selected" : ""}`}
                              disabled={!pending || busy}
                              onClick={() => setPickedOption(option.id)}
                            >
                              {option.lineName && (
                                <p className="cr-line-name">{option.lineName}</p>
                              )}
                              <div className="cr-option-top">
                                <strong>{option.title}</strong>
                                {recommended && <span className="cr-pill accent">Recommended</span>}
                              </div>
                              {(option.kind === "ferry_hotel" || option.kind === "ferry" || option.kind === "hotel") && (
                                <div className="cr-kind-row">
                                  {(option.kind === "ferry_hotel" || option.kind === "ferry") && <span className="cr-pill">Ferry</span>}
                                  {(option.kind === "ferry_hotel" || option.kind === "hotel") && <span className="cr-pill">Hotel</span>}
                                </div>
                              )}
                              <div className="cr-metrics" aria-label="Price and time">
                                <div className="cr-metric">
                                  <span className="cr-metric-label">Price</span>
                                  <span className="cr-metric-value price">{option.priceLabel ?? `€${option.priceEur ?? "—"}`}</span>
                                </div>
                                <div className="cr-metric">
                                  <span className="cr-metric-label">Time</span>
                                  <span className="cr-metric-value time">{option.timeLabel ?? "—"}</span>
                                </div>
                              </div>
                              <p className="cr-delay">{option.delayLabel}</p>
                              {option.components && option.components.length > 0 && (
                                <div className="cr-breakdown">
                                  <p className="cr-breakdown-label">Price breakdown</p>
                                  <ul className="cr-components">
                                    {option.components.map((part) => (
                                      <li key={part.label}>
                                        <span>{part.label}</span>
                                        <span className="num">{part.priceLabel}</span>
                                        <span className="cr-comp-time">{part.timeLabel}</span>
                                      </li>
                                    ))}
                                    <li className="cr-components-total">
                                      <span>Total</span>
                                      <span className="num">{option.priceLabel}</span>
                                      <span />
                                    </li>
                                  </ul>
                                </div>
                              )}
                              <p className="cr-option-summary">{option.summary}</p>
                              <p className="cr-ops"><b>Ops:</b> {option.opsNext}</p>
                            </button>
                          )
                        })}
                      </div>
                    </section>

                    <footer className="cr-approve">
                      {run.status === "approved" && chosenOption && (
                        <p className="cr-result ok">
                          Approved: {chosenOption.title} · {chosenOption.priceLabel} · {chosenOption.timeLabel}
                        </p>
                      )}
                      {run.status === "changed" && (
                        <p className="cr-result warn">Changed by ops{run.changeNote ? ` — ${run.changeNote}` : ""}</p>
                      )}
                      {pending && (
                        <>
                          <div className="cr-approve-row">
                            <button type="button" className="cr-primary" disabled={busy || !pickedOption} onClick={() => void decide("approved")}>
                              Approve
                            </button>
                            <button type="button" className="cr-secondary" disabled={busy} onClick={() => setShowChange((v) => !v)}>
                              Change
                            </button>
                          </div>
                          {showChange && (
                            <div className="cr-change">
                              <label htmlFor="change-note">How will you handle this?</label>
                              <textarea
                                id="change-note"
                                rows={3}
                                value={changeNote}
                                onChange={(event) => setChangeNote(event.target.value)}
                                placeholder="e.g. Customer arranges their own tow; wait for their instruction."
                              />
                              <button type="button" className="cr-primary" disabled={busy} onClick={() => void decide("changed")}>
                                Save change
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </footer>

                    {run.status === "approved" && bookingFields.length > 0 && (
                      <section className="cr-booking" aria-label="Ops booking contacts">
                        <div className="cr-booking-head">
                          <h3>Ops completes contacts</h3>
                          <p>
                            The agent left these blank on purpose — it never contacts the paying customer and does not place
                            real ferry/hotel bookings. Fill what you need after Approve (mock only).
                          </p>
                        </div>
                        <div className="cr-booking-grid">
                          {bookingFields.map((field) => (
                            <label key={field.key} className="cr-booking-field" htmlFor={`booking-${field.key}`}>
                              <span className="cr-booking-label">
                                {field.label}
                                {field.required ? " *" : ""}
                              </span>
                              <input
                                id={`booking-${field.key}`}
                                value={bookingForm[field.key] ?? ""}
                                placeholder={field.placeholder}
                                disabled={busy}
                                onChange={(event) => setBookingForm((prev) => ({ ...prev, [field.key]: event.target.value }))}
                              />
                              <span className="cr-booking-reason">{field.reason}</span>
                            </label>
                          ))}
                        </div>
                        <div className="cr-approve-row">
                          <button type="button" className="cr-primary" disabled={busy} onClick={() => void saveBookingDetails()}>
                            Save booking contacts
                          </button>
                          {bookingSaved && <span className="cr-booking-saved">Saved — still mock; no purchase made.</span>}
                        </div>
                      </section>
                    )}

                    <details className="cr-secondary">
                      <summary>What happened, facts, and agent work</summary>
                      <div className="cr-secondary-body">
                        <section className="cr-block">
                          <h3>What happened</h3>
                          <p className="cr-lead">{run.decision.happened}</p>
                        </section>

                        <section className="cr-block">
                          <h3>Facts with sources</h3>
                          <ul className="cr-facts">
                            {run.decision.facts.slice(0, 10).map((fact, index) => (
                              <li key={`${fact.label}-${index}`}>
                                <div>
                                  <strong>{fact.label}</strong>
                                  <p>{fact.value}</p>
                                </div>
                                <span className="cr-source">{fact.source}</span>
                              </li>
                            ))}
                          </ul>
                        </section>

                        <section className="cr-block">
                          <h3>What the agent did</h3>
                          <ol className="cr-actions">
                            {run.decision.actions.map((action, index) => (
                              <li key={`${action.tool}-${index}`}>
                                <span className="cr-tool mono">{action.tool}</span>
                                <span>{action.summary}</span>
                              </li>
                            ))}
                          </ol>
                          <p className="cr-note">Customer contact blocked · booking / cost / date / customer message need approval</p>
                        </section>
                      </div>
                    </details>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </main>
    </AppFrame>
  )
}
