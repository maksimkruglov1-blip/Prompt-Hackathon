"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { formatBookingDraftText } from "@/lib/agent/on-the-road/booking-draft"
import type { AgentRunRecord, DeliveryTimeline, DriverChatThread, QueueItem } from "@/lib/agent/types"
import { factSourceLabel, humanizeClientError } from "@/lib/agent/ui-copy"
import { URGENCY_RULES, type UrgencyClass } from "@/lib/agent/urgency"
import { AppFrame } from "../app-frame"

type QueueResponse = {
  snapshotAt: string | null
  mode: "mock" | "llm"
  items: QueueItem[]
  /** Decided cases — not in the active queue. */
  handled?: QueueItem[]
  /** Background runs still writing proposals. */
  precomputing?: number
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
  currentLocation?: { label: string; known: boolean; source: string }
  deliveryStage?: { label: string; short: string; source: string; tone: string; known: boolean }
  deliveryTimeline?: DeliveryTimeline | null
  driverChat?: DriverChatThread | null
  urgencyClass?: UrgencyClass
  urgencyLabel?: string
  urgencyReason?: string
  urgencyShortReason?: string
  safetyFlag?: "driver" | "order" | null
  slackHours?: number | null
  agentWorking?: boolean
  /** Live tool calls while a background run is still in flight. */
  workingActions?: { tool: string; summary: string; at: string; detail?: string | null }[]
  refreshedStale?: boolean
  alerts: { id: string; signal: string; severity: string; status: string; summary: string }[]
  attention: { title: string; detail: string | null; tone: string; short: string }[]
  error?: string
}

function decisionHasFerryOptions(run: AgentRunRecord | null | undefined): boolean {
  if (!run?.decision?.options?.length) return false
  return run.decision.options.some((option) =>
    option.kind === "ferry"
    || option.kind === "ferry_hotel"
    || /tallink|viking|finnlines|eckerö|eckero|ferry|sailing/i.test(`${option.lineName ?? ""} ${option.title}`),
  )
}

function routeLooksInlandSameCountry(route: string | null | undefined): boolean {
  if (!route) return false
  // "Munich, DE → Hamburg, DE" or "Munich → Hamburg" with DE tokens
  const parts = route.split("→").map((part) => part.trim())
  if (parts.length < 2) return false
  const code = (text: string) => {
    const m = text.match(/\b([A-Z]{2})\b/)
    if (m) return m[1]
    if (/finland|helsinki/i.test(text)) return "FI"
    if (/germany|munich|hamburg|leipzig|ingolstadt|berlin/i.test(text)) return "DE"
    return null
  }
  const a = code(parts[0]!)
  const b = code(parts[1]!)
  return Boolean(a && b && a === b)
}

const STATUS_LABEL: Record<QueueItem["agentStatus"], string> = {
  idle: "No agent",
  working: "Agent working",
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
  const [draftCopied, setDraftCopied] = useState(false)
  const [showOtherOptions, setShowOtherOptions] = useState(false)
  const [changeRerunNote, setChangeRerunNote] = useState<string | null>(null)
  const [staleFixNote, setStaleFixNote] = useState<string | null>(null)
  const [showTraceDetails, setShowTraceDetails] = useState(false)
  const [showHandled, setShowHandled] = useState(false)
  const [agentProgress, setAgentProgress] = useState(false)
  const [progressNote, setProgressNote] = useState("Gathering facts from the driver and the record — preparing options.")
  const [showUrgencyExplainer, setShowUrgencyExplainer] = useState(false)

  const loadQueue = useCallback(async () => {
    try {
      const response = await fetch("/api/control-room")
      const data = await response.json() as QueueResponse
      if (!response.ok) throw new Error(data.error || "Could not load the attention queue")
      setQueue(data)
      setError("")
      // Keep the open card after Approve even when it leaves the active queue.
      setSelectedId((current) => {
        if (current) return current
        const ferry = data.items.find((item) => item.reference === "CD-420299")
        const bentley = data.items.find((item) => item.reference === "CD-420322")
        return ferry?.orderId ?? bentley?.orderId ?? data.items[0]?.orderId ?? null
      })
    } catch (cause) {
      setError(humanizeClientError(cause instanceof Error ? cause.message : "", "Could not load the attention queue"))
    }
  }, [])

  useEffect(() => { void loadQueue() }, [loadQueue])

  const runAgentFor = useCallback(async (orderId: string, opts?: { quietQueue?: boolean; note?: string }) => {
    setBusy(true)
    setAgentProgress(true)
    setProgressNote(opts?.note ?? "Gathering facts from the driver and the record — preparing options.")
    setError("")
    try {
      const response = await fetch(`/api/agent/on-the-road/${orderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      })
      const data = await response.json() as { card?: DecisionResponse; error?: string }
      if (!response.ok) throw new Error(data.error || "Agent failed")
      if (data.card) {
        setDecision(data.card)
        setPickedOption(data.card.run?.decision.recommendationId ?? data.card.run?.decision.options[0]?.id ?? null)
        requestAnimationFrame(() => {
          document.getElementById("cr-choose-options")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        })
      }
      if (!opts?.quietQueue) await loadQueue()
    } catch (cause) {
      setError(humanizeClientError(cause instanceof Error ? cause.message : "", "The agent could not finish. Try again."))
    } finally {
      setBusy(false)
      setAgentProgress(false)
    }
  }, [loadQueue])

  useEffect(() => {
    if (!selectedId) {
      setDecision(null)
      setLoadingDecision(false)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    const workingPoll = { id: null as number | null }
    // Drop the previous card immediately so a ferry case never flashes on a roadside selection.
    setDecision(null)
    setLoadingDecision(true)
    setShowChange(false)
    setChangeNote("")
    setPickedOption(null)
    setBookingForm({})
    setBookingSaved(false)
    setShowOtherOptions(false)
    setChangeRerunNote(null)
    setStaleFixNote(null)
    setShowTraceDetails(false)
    setAgentProgress(false)
    setProgressNote("Gathering facts from the driver and the record — preparing options.")
    fetch(`/api/control-room/${selectedId}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as DecisionResponse
        if (!response.ok) throw new Error(data.error || "Could not load the decision card")
        if (cancelled) return
        setDecision(data)
        setPickedOption(data.run?.decision.recommendationId ?? data.run?.decision.options[0]?.id ?? null)
        setBookingForm(data.run?.opsDetails ?? {})
        setBookingSaved(!!data.run?.opsDetails && Object.keys(data.run.opsDetails).length > 0)
        setLoadingDecision(false)

        const inlandFerry =
          data.run?.status === "pending"
          && routeLooksInlandSameCountry(data.route)
          && decisionHasFerryOptions(data.run)

        // Background precompute may still be writing — show working state and poll (no empty card).
        if (!data.run && data.agentWorking) {
          setAgentProgress(true)
          setProgressNote("Agent working — gathering facts and preparing options…")
          workingPoll.id = window.setInterval(() => {
            if (cancelled) {
              if (workingPoll.id != null) window.clearInterval(workingPoll.id)
              return
            }
            void fetch(`/api/control-room/${selectedId}`)
              .then(async (response) => {
                const next = await response.json() as DecisionResponse
                if (!response.ok || cancelled) return
                if (next.run) {
                  if (workingPoll.id != null) window.clearInterval(workingPoll.id)
                  workingPoll.id = null
                  setDecision(next)
                  setPickedOption(next.run.decision.recommendationId ?? next.run.decision.options[0]?.id ?? null)
                  setAgentProgress(false)
                  await loadQueue()
                } else {
                  setDecision(next)
                  setProgressNote("Agent working — tool calls in progress…")
                }
              })
              .catch(() => { /* keep polling */ })
          }, 900)
          return
        }

        // Fallback seed only when nothing is stored and nothing is in flight.
        if (!data.run && !data.agentWorking && (data.onRoad || data.attention.length > 0)) {
          await runAgentFor(selectedId, { quietQueue: true })
          if (!cancelled) await loadQueue()
        } else if (inlandFerry && !data.refreshedStale) {
          await runAgentFor(selectedId, {
            quietQueue: true,
            note: "Outdated ferry options found for an inland route — preparing tow / roadside options…",
          })
          if (!cancelled) {
            setStaleFixNote("Replaced outdated ferry proposal with tow / roadside options.")
            await loadQueue()
          }
        } else if (data.refreshedStale) {
          setStaleFixNote("Replaced outdated ferry proposal with tow / roadside options.")
          requestAnimationFrame(() => {
            document.getElementById("cr-choose-options")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
          })
        } else if (data.run?.decision.options.length) {
          requestAnimationFrame(() => {
            document.getElementById("cr-choose-options")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
          })
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || cancelled) return
        setDecision(null)
        setError(humanizeClientError(cause instanceof Error ? cause.message : "", "Could not load the decision card"))
        setLoadingDecision(false)
      })
    return () => {
      cancelled = true
      controller.abort()
      if (workingPoll.id != null) window.clearInterval(workingPoll.id)
    }
  }, [selectedId, runAgentFor, loadQueue])

  async function runAgent() {
    if (!selectedId) return
    await runAgentFor(selectedId)
  }

  async function decide(status: "approved" | "changed") {
    if (!selectedId) return
    const liveRun = decision?.orderId === selectedId ? decision.run : null
    const options = liveRun?.decision.options ?? []
    const optionId =
      (pickedOption && options.some((o) => o.id === pickedOption) ? pickedOption : null)
      ?? liveRun?.decision.recommendationId
      ?? options[0]?.id
      ?? null
    if (status === "approved" && !optionId) {
      setError("Select an option above before Approve")
      document.getElementById("cr-approve")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      return
    }
    if (status === "approved" && optionId) {
      const option = options.find((o) => o.id === optionId)
      const missing = (option?.bookingFields ?? []).filter((field) => {
        if (!field.required) return false
        const value = (bookingForm[field.key] ?? field.prefill ?? "").trim()
        return !value
      })
      if (missing.length > 0) {
        setError(`Fill required booking draft before Approve: ${missing.map((f) => f.label).join(", ")}`)
        document.getElementById("cr-booking-draft")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        return
      }
      // Keep React state aligned so the button never looks “selected recommended / Approve dead”.
      if (pickedOption !== optionId) setPickedOption(optionId)
    }
    setBusy(true)
    setError("")
    try {
      const response = await fetch(`/api/agent/on-the-road/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "decide",
          status,
          optionId,
          changeNote: changeNote || undefined,
          opsDetails: status === "approved" ? bookingForm : undefined,
        }),
      })
      const data = await response.json() as {
        card?: DecisionResponse
        error?: string
        changeRerun?: boolean
        previousChangeNote?: string
      }
      if (!response.ok) throw new Error(data.error || "Could not save the decision")
      if (data.card) {
        setDecision(data.card)
        setBookingForm(data.card.run?.opsDetails ?? {})
        setBookingSaved(false)
        setPickedOption(
          data.card.run?.selectedOptionId
          ?? data.card.run?.decision.recommendationId
          ?? data.card.run?.decision.options[0]?.id
          ?? null,
        )
        setShowOtherOptions(false)
      }
      setShowChange(false)
      if (status === "changed" && data.changeRerun) {
        setChangeRerunNote(data.previousChangeNote ?? changeNote)
        setChangeNote("")
      }
      await loadQueue()
      if (status === "approved") {
        requestAnimationFrame(() => {
          document.getElementById("cr-approve")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        })
      }
    } catch (cause) {
      setError(humanizeClientError(cause instanceof Error ? cause.message : "", "Could not save the decision"))
      requestAnimationFrame(() => {
        document.getElementById("cr-approve")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      })
    } finally {
      setBusy(false)
    }
  }

  async function saveBookingDetails() {
    if (!selectedId) return
    setBusy(true)
    setError("")
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
      setError(humanizeClientError(cause instanceof Error ? cause.message : "", "Could not save booking contacts"))
    } finally {
      setBusy(false)
    }
  }

  // Guard against one-paint stale cards when selectedId changes before fetch settles.
  const card = decision?.orderId === selectedId ? decision : null
  const run = card?.run ?? null
  const pending = run?.status === "pending"
  const chosenOption = run?.selectedOptionId
    ? run.decision.options.find((option) => option.id === run.selectedOptionId) ?? null
    : null
  const draftOption = pending
    ? (run?.decision.options.find((option) => option.id === pickedOption) ?? null)
    : chosenOption
  const bookingFields = draftOption?.bookingFields ?? chosenOption?.bookingFields ?? []
  const topFacts = (run?.decision.facts ?? []).slice(0, 5)
  const isTowCase = draftOption?.kind === "recovery"
    || chosenOption?.kind === "recovery"
    || run?.decision.options.some((o) => o.kind === "recovery")

  // Keep a valid selected option whenever the pending run is on screen (Approve must never be a dead control).
  useEffect(() => {
    if (!run || run.status !== "pending") return
    const ids = new Set(run.decision.options.map((option) => option.id))
    if (pickedOption && ids.has(pickedOption)) return
    const fallback =
      (run.decision.recommendationId && ids.has(run.decision.recommendationId)
        ? run.decision.recommendationId
        : null)
      ?? run.decision.options[0]?.id
      ?? null
    if (fallback) setPickedOption(fallback)
  }, [run?.id, run?.status, run?.decision.recommendationId, run?.decision.options, pickedOption])

  // Seed editable draft from agent prefills when the selected option changes.
  useEffect(() => {
    if (!draftOption?.bookingFields?.length) return
    if (run?.opsDetails && Object.keys(run.opsDetails).length > 0 && run.status === "approved") {
      setBookingForm(run.opsDetails)
      return
    }
    const seeded: Record<string, string> = {}
    for (const field of draftOption.bookingFields) {
      seeded[field.key] = field.prefill ?? ""
    }
    setBookingForm(seeded)
    setDraftCopied(false)
  }, [draftOption?.id, pickedOption, run?.id, run?.status])

  async function copyAndOpenDraft() {
    if (!draftOption) return
    const text = formatBookingDraftText(
      draftOption.title,
      card?.reference ?? "",
      bookingFields,
      bookingForm,
    )
    try {
      await navigator.clipboard.writeText(text)
      setDraftCopied(true)
      window.setTimeout(() => setDraftCopied(false), 2500)
    } catch {
      setError("Could not copy draft — select the text manually if needed.")
    }
    if (draftOption.bookUrl) {
      window.open(draftOption.bookUrl, "_blank", "noopener,noreferrer")
    }
  }
  const sortedOptions = (() => {
    const options = run?.decision.options ?? []
    const recId = run?.decision.recommendationId
    if (!recId) return options
    const rec = options.find((o) => o.id === recId)
    if (!rec) return options
    return [rec, ...options.filter((o) => o.id !== recId)]
  })()
  const primaryOption = sortedOptions[0] ?? null
  const altOption = sortedOptions[1] ?? null
  const moreOptions = sortedOptions.slice(2)
  const agentActions = run?.decision.actions ?? run?.toolTrace ?? []
  const isTravelFerryCase = run?.decision.stage === "travel"
    || run?.decision.options.some((o) => o.kind === "ferry" || o.kind === "ferry_hotel")

  function formatActionTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    } catch {
      return ""
    }
  }

  /** Driver chat: always date + time so a multi-day thread is scannable (not clock-only). */
  function formatChatTime(iso: string): string {
    try {
      const date = new Date(iso)
      const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      return `${day} · ${time}`
    } catch {
      return ""
    }
  }

  function toolLabel(tool: string): string {
    if (tool === "ask_driver") return "Asked driver"
    if (tool === "lookup_order") return "Looked up order"
    if (tool === "gather_facts") return "Gathered facts"
    if (tool === "estimate_recovery") return "Estimated tow"
    if (tool === "search_trips") return "Searched trips"
    return tool.replaceAll("_", " ")
  }

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
              <p className="cr-empty">No orders waiting on a person. Quiet shift — check Inbox if something feels missing.</p>
            )}
            {queue && queue.items.length > 0 && (
              <ul className="cr-queue-list">
                {queue.items.map((item, index) => {
                  const active = item.orderId === selectedId
                  const prev = queue.items[index - 1]
                  const cls = item.urgencyClass ?? "P3"
                  const showTier = !prev || (prev.urgencyClass ?? "P3") !== cls
                  return (
                    <li key={item.orderId}>
                      {showTier && (
                        <p className={`cr-queue-tier urgency-${item.urgency} class-${cls}`}>
                          <span>{cls} · {item.urgencyLabel}</span>
                          <span className="num">
                            {queue.items.filter((row) => (row.urgencyClass ?? "P3") === cls).length}
                          </span>
                        </p>
                      )}
                      <div
                        className={`cr-qitem tone-${item.reasonTone} urgency-${item.urgency} class-${cls}${active ? " active" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(item.orderId)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            setSelectedId(item.orderId)
                          }
                        }}
                        aria-current={active ? "true" : undefined}
                      >
                        <div className="cr-qtop">
                          <span className="cr-qvehicle">{item.vehicle}</span>
                          <div className="cr-qtop-right">
                            <button
                              type="button"
                              className={`cr-urgency-chip class-${cls}`}
                              title={`${cls}: ${item.urgencyReason || item.urgencyLabel}${item.safetyFlag ? ` · safety from ${item.safetyFlag}` : ""}. Click for scoring rules.`}
                              aria-label={`${cls} urgency — how urgency is scored`}
                              onClick={(event) => {
                                event.stopPropagation()
                                setShowUrgencyExplainer(true)
                              }}
                            >
                              {cls}
                              {item.urgencyShortReason ? ` · ${item.urgencyShortReason}` : ""}
                            </button>
                            <span className="cr-qwait num" title="Time since raised">{item.waitingLabel}</span>
                          </div>
                        </div>
                        <div className="cr-qmeta">
                          <span className="mono">{item.reference}</span>
                          <span>{item.route}</span>
                        </div>
                        <p className={`cr-qstage${item.deliveryStageKnown ? "" : " unknown"}`}>
                          {item.deliveryStage || "Stage unknown"}
                        </p>
                        <p className="cr-qreason">{item.reason}</p>
                        <div className="cr-qfoot">
                          <span className={`cr-pill status-${item.agentStatus}`}>{STATUS_LABEL[item.agentStatus]}</span>
                          {item.signal && <span className="cr-signal">{item.signal}</span>}
                          {item.safetyFlag && (
                            <span className="cr-signal" title="P1 safety provenance">
                              safety · {item.safetyFlag}
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {queue && (queue.handled?.length ?? 0) > 0 && (
              <div className="cr-handled">
                <button type="button" className="cr-handled-toggle" onClick={() => setShowHandled((v) => !v)}>
                  {showHandled ? "Hide" : "Handled today"} ({queue.handled!.length})
                </button>
                {showHandled && (
                  <ul className="cr-handled-list">
                    {queue.handled!.map((item) => (
                      <li key={`handled-${item.orderId}`}>
                        <button
                          type="button"
                          className={`cr-qitem handled${item.orderId === selectedId ? " active" : ""}`}
                          onClick={() => setSelectedId(item.orderId)}
                        >
                          <div className="cr-qtop">
                            <span className="cr-qvehicle">{item.vehicle}</span>
                            <span className={`cr-pill status-${item.agentStatus}`}>{STATUS_LABEL[item.agentStatus]}</span>
                          </div>
                          <div className="cr-qmeta">
                            <span className="mono">{item.reference}</span>
                            <span>{item.route}</span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="cr-decision" aria-label="Decision panel">
            {!selectedId && <p className="cr-empty pane">Select an order from the queue.</p>}
            {selectedId && loadingDecision && (
              <div className="cr-decision-skel" aria-busy="true" aria-label="Loading decision card" />
            )}
            {selectedId && !loadingDecision && !card && !agentProgress && (
              <div className="cr-callout">
                <h3>Could not open this case</h3>
                <p>Refresh the page, or pick another order from the queue. If Docker is down, start it and try again.</p>
                <button type="button" className="cr-secondary" disabled={busy} onClick={() => void loadQueue()}>
                  Reload queue
                </button>
              </div>
            )}
            {selectedId && !loadingDecision && card && (
              <>
                <header className="cr-decision-head">
                  <div>
                    <p className="cr-eyebrow">
                      {card.urgencyClass && (
                        <button
                          type="button"
                          className={`cr-urgency-chip inline class-${card.urgencyClass}`}
                          title={card.urgencyReason ?? card.urgencyLabel}
                          aria-label={`${card.urgencyClass} urgency — how urgency is scored`}
                          onClick={() => setShowUrgencyExplainer(true)}
                        >
                          {card.urgencyClass}
                        </button>
                      )}
                      <span>{card.reference} · {card.route}</span>
                    </p>
                    <h2>{card.vehicle}</h2>
                    <p className="cr-customer">
                      {card.customer}
                      <span> · agent must not contact</span>
                      <span className="cr-mode-pill" title={card.mode === "llm" ? "OPENAI_API_KEY is set" : "No API key — mock path"}>
                        · agent {run?.mode ?? card.mode}
                      </span>
                    </p>
                    {card.urgencyReason && (
                      <p className="cr-urgency-why">{card.urgencyReason}</p>
                    )}
                  </div>
                  <div className="cr-decision-tools">
                    <Link className="cr-ghost" href={`/orders/${card.orderId}`}>Open record</Link>
                    <button type="button" className="cr-ghost" disabled={busy} onClick={() => void runAgent()}>
                      {run ? "Re-run agent" : "Run on-the-road agent"}
                    </button>
                  </div>
                </header>

                {!run && (
                  <p
                    className={`cr-stage tone-${card.deliveryStage?.tone ?? "neutral"}${card.deliveryStage?.known === false ? " unknown" : ""}`}
                    role="status"
                    title={card.deliveryStage?.source}
                  >
                    <span className="cr-stage-label">Delivery stage</span>
                    <span className="cr-stage-value">
                      {card.deliveryStage?.label ?? "Stage unknown"}
                    </span>
                  </p>
                )}

                {(agentProgress || card.agentWorking || (busy && !run)) && (
                  <div className="cr-agent-progress" role="status" aria-live="polite">
                    <div className="cr-agent-progress-bar" aria-hidden="true" />
                    <h3>Agent working</h3>
                    <p>{progressNote} The queue stays open; only this card waits.</p>
                    {(card.workingActions?.length ?? 0) > 0 && (
                      <ul className="cr-working-tools" aria-label="Tool calls in progress">
                        {card.workingActions!.map((action, index) => (
                          <li key={`${action.tool}-${index}`}>
                            <span className="cr-tool mono">{action.tool}</span>
                            <span>{action.summary}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {!run && !agentProgress && (
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

                    <p
                      className={`cr-stage tone-${card.deliveryStage?.tone ?? "neutral"}${card.deliveryStage?.known === false ? " unknown" : ""}`}
                      role="status"
                      title={card.deliveryStage?.source}
                    >
                      <span className="cr-stage-label">Delivery stage</span>
                      <span className="cr-stage-value">
                        {card.deliveryStage?.label ?? "Stage unknown"}
                      </span>
                    </p>

                    {card.deliveryTimeline && card.deliveryTimeline.steps.length > 0 && (
                      <section
                        className="cr-dates"
                        aria-label="Delivery timeline"
                        title={card.deliveryTimeline.source}
                      >
                        <div className="cr-dates-head">
                          <h3>Delivery timeline</h3>
                          {card.deliveryTimeline.bottleneck && (
                            <p className="cr-dates-sub">{card.deliveryTimeline.bottleneck}</p>
                          )}
                        </div>
                        <ol className="cr-dates-rail" aria-label="Shared stages">
                          {card.deliveryTimeline.steps.map((step, index) => (
                            <li
                              key={step.id}
                              className={`cr-dates-stage kind-${step.kind} state-${step.state} tone-${step.tone}`}
                            >
                              {index > 0 && <span className="cr-dates-rail-line" aria-hidden="true" />}
                              <span className="cr-dates-dot" aria-hidden="true" />
                              <p className="cr-dates-label">{step.label}</p>
                              <p className="cr-dates-when num">{step.whenLabel}</p>
                              {step.whereLabel && (
                                <p className="cr-dates-where">{step.whereLabel}</p>
                              )}
                              {step.detail && (
                                <p className="cr-dates-detail">{step.detail}</p>
                              )}
                            </li>
                          ))}
                        </ol>
                        {run.decision.deliveryTiming?.impactLabel && (
                          <p
                            className={`cr-timing-impact alone tone-${run.decision.deliveryTiming.tone}`}
                            role="status"
                          >
                            {run.decision.deliveryTiming.impactLabel}
                          </p>
                        )}
                      </section>
                    )}

                                        <section className="cr-driver-chat" aria-label="Driver chat">
                      <div className="cr-driver-chat-head">
                        <h3>Driver chat</h3>
                        <p className="cr-driver-chat-sub">
                          {card.driverChat?.subtitle
                            ?? "Thread with the assigned driver · never the paying customer"}
                        </p>
                      </div>
                      {!card.driverChat?.messages.length ? (
                        <p className="cr-driver-chat-empty">No driver messages yet</p>
                      ) : (
                        <ul className="cr-driver-chat-thread">
                          {card.driverChat.messages.map((msg) => (
                            <li key={msg.id} className={`cr-chat-bubble role-${msg.role}`}>
                              <div className="cr-chat-meta">
                                <span className="cr-chat-who">{msg.roleLabel}</span>
                                <span className="cr-chat-time num">{formatChatTime(msg.at)}</span>
                                {msg.source === "ask_driver" && (
                                  <span className="cr-chat-source">ask_driver</span>
                                )}
                              </div>
                              <p className="cr-chat-body">{msg.body}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {topFacts.length > 0 && (
                      <section className="cr-fact-strip" aria-label="Facts with sources">
                        <h3>Facts</h3>
                        <ul>
                          {topFacts.map((fact, index) => (
                            <li key={`${fact.label}-${index}`}>
                              <div className="cr-fact-main">
                                <strong>{fact.label}</strong>
                                <p>{fact.value.length > 160 ? `${fact.value.slice(0, 157)}…` : fact.value}</p>
                              </div>
                              <span className="cr-source" title={fact.source}>
                                {factSourceLabel(fact.source, fact.sourceKind)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                    {changeRerunNote && pending && (
                      <p className="cr-result warn" role="status">
                        New proposal after your Change note: “{changeRerunNote}”
                      </p>
                    )}
                    {staleFixNote && pending && (
                      <p className="cr-result warn" role="status">{staleFixNote}</p>
                    )}

                    {agentActions.length > 0 && (
                      <section className="cr-trace" aria-label="What the agent did">
                        <h3>What the agent did</h3>
                        {(run.decision.stage === "recover" || isTowCase) && (
                          <p className="cr-trace-stage">
                            Staged: safety &amp; location first → then recovery options only (no ferries).
                          </p>
                        )}
                        {run.decision.stage === "travel" && (
                          <p className="cr-trace-stage">
                            Staged: travel capacity — sailing / lodging options (not a roadside tow step).
                          </p>
                        )}
                        <p className="cr-trace-compact">
                          {agentActions.slice(0, 6).map((action, index) => (
                            <span key={`${action.tool}-${index}`}>
                              {index > 0 && <span className="cr-trace-sep"> · </span>}
                              <span className="cr-trace-step">{toolLabel(action.tool)}</span>
                              {formatActionTime(action.at) && (
                                <span className="cr-trace-time num"> {formatActionTime(action.at)}</span>
                              )}
                            </span>
                          ))}
                        </p>
                        <button
                          type="button"
                          className="cr-ghost cr-trace-toggle"
                          onClick={() => setShowTraceDetails((v) => !v)}
                        >
                          {showTraceDetails ? "Hide steps" : "Show steps"}
                        </button>
                        {showTraceDetails && (
                          <ol className="cr-trace-list">
                            {agentActions.slice(0, 12).map((action, index) => (
                              <li key={`${action.tool}-detail-${index}`}>
                                <span className="cr-trace-time num">{formatActionTime(action.at)}</span>
                                <span className="cr-trace-step">{toolLabel(action.tool)}</span>
                                <span className="cr-trace-detail">{action.summary}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </section>
                    )}

                    <section id="cr-choose-options" className="cr-block cr-hero-choice">
                      <div className="cr-choice-head">
                        <p className="cr-stage-kicker">
                          {run.decision.stage === "travel"
                            ? "Travel"
                            : run.decision.stage === "recover" || isTowCase
                              ? "Recovery"
                              : "Decision"}
                        </p>
                        <h3>{run.decision.stageTitle ?? (isTowCase ? "Step 1 · Choose recovery" : "Choose an option")}</h3>
                        <p className="cr-choice-prompt">
                          {run.decision.stagePrompt
                            ?? (isTowCase
                              ? "What should we do? Choose recovery first — tow destination only."
                              : run.decision.summary && run.decision.summary !== run.decision.problem
                                ? run.decision.summary
                                : "What should we do?")}
                        </p>
                      </div>
                      {isTravelFerryCase && (
                        <p className="cr-rest-note" role="note">
                          Travemünde–Helsinki Finnlines is required. Driver rest hours block long extra driving — if tonight is sold out, book the next Finnlines sailing and rest at Travemünde.
                        </p>
                      )}
                          <div
                            className="cr-options stacked"
                            role="radiogroup"
                            aria-label={
                              run.decision.stage === "recover" || isTowCase
                                ? "Recovery options — tow destinations"
                                : run.decision.stage === "travel"
                                  ? "Sailing options"
                                  : "Proposed options"
                            }
                          >
                            {primaryOption && (() => {
                              const option = primaryOption
                              const selected = pickedOption === option.id
                              const selectable = pending && !busy
                              return (
                                <div
                                  key={option.id}
                                  role="radio"
                                  tabIndex={selectable ? 0 : -1}
                                  aria-checked={selected}
                                  aria-disabled={!selectable}
                                  className={`cr-option primary${selected ? " selected" : ""}${!selectable ? " disabled" : ""}`}
                                  onClick={() => { if (selectable) setPickedOption(option.id) }}
                                  onKeyDown={(event) => {
                                    if (!selectable) return
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault()
                                      setPickedOption(option.id)
                                    }
                                  }}
                                >
                                  <div className="cr-option-top">
                                    <div>
                                      {option.lineName && <p className="cr-line-name">{option.lineName}</p>}
                                      <strong>{option.title}</strong>
                                    </div>
                                    <span className="cr-pill accent">Recommended</span>
                                  </div>
                                  <div className="cr-kind-row">
                                    {option.kind === "recovery" && <span className="cr-pill">Tow</span>}
                                  </div>
                                  <div className="cr-metrics primary-metrics" aria-label="Price and time">
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
                                  {option.arrivalLabel && (
                                    <p className="cr-arrival">Arrives Helsinki · <span className="num">{option.arrivalLabel}</span></p>
                                  )}
                                  {option.verdict && <p className="cr-verdict">{option.verdict}</p>}
                                  {option.components && option.components.length > 0 && (
                                    <div className="cr-breakdown">
                                      <p className="cr-breakdown-label">Price breakdown</p>
                                      <ul className="cr-components">
                                        {option.components.map((part) => (
                                          <li key={part.label}>
                                            <span title={part.label}>{part.label}</span>
                                            <span className="num">{part.priceLabel}</span>
                                            <span className="cr-comp-time" title={part.timeLabel}>{part.timeLabel}</span>
                                          </li>
                                        ))}
                                        <li className="cr-components-total">
                                          <span>Total</span>
                                          <span className="num">{option.priceLabel}</span>
                                        </li>
                                      </ul>
                                    </div>
                                  )}
                                  <p className="cr-option-summary">{option.summary}</p>
                                  {option.bookUrl && (
                                    <div className="cr-book-row" onClick={(event) => event.stopPropagation()}>
                                      <a
                                        className="cr-book"
                                        data-testid={`book-${option.id}`}
                                        href={option.bookUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        Book
                                      </a>
                                    </div>
                                  )}
                                </div>
                              )
                            })()}

                            {altOption && (() => {
                              const option = altOption
                              const selected = pickedOption === option.id
                              const selectable = pending && !busy
                              return (
                                <div
                                  key={option.id}
                                  role="radio"
                                  tabIndex={selectable ? 0 : -1}
                                  aria-checked={selected}
                                  aria-disabled={!selectable}
                                  className={`cr-option compact${selected ? " selected" : ""}${!selectable ? " disabled" : ""}`}
                                  onClick={() => { if (selectable) setPickedOption(option.id) }}
                                  onKeyDown={(event) => {
                                    if (!selectable) return
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault()
                                      setPickedOption(option.id)
                                    }
                                  }}
                                >
                                  <div className="cr-option-top">
                                    <div>
                                      {option.lineName && <p className="cr-line-name">{option.lineName}</p>}
                                      <strong>{option.title}</strong>
                                    </div>
                                    <span className="cr-pill">Alternative</span>
                                  </div>
                                  <div className="cr-metrics" aria-label="Price and time">
                                    <div className="cr-metric">
                                      <span className="cr-metric-label">Price</span>
                                      <span className="cr-metric-value price">{option.priceLabel}</span>
                                    </div>
                                    <div className="cr-metric">
                                      <span className="cr-metric-label">Time</span>
                                      <span className="cr-metric-value time">{option.timeLabel}</span>
                                    </div>
                                  </div>
                                  <p className="cr-delay">{option.delayLabel}</p>
                                  {option.arrivalLabel && (
                                    <p className="cr-arrival">Arrives · <span className="num">{option.arrivalLabel}</span></p>
                                  )}
                                  {option.verdict && <p className="cr-verdict">{option.verdict}</p>}
                                  {option.bookUrl && (
                                    <div className="cr-book-row" onClick={(event) => event.stopPropagation()}>
                                      <a
                                        className="cr-book"
                                        data-testid={`book-${option.id}`}
                                        href={option.bookUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        Book
                                      </a>
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </div>

                          {moreOptions.length > 0 && (
                            <div className="cr-other-options">
                              <button type="button" className="cr-ghost" onClick={() => setShowOtherOptions((v) => !v)}>
                                {showOtherOptions ? "Hide" : "Other options"} ({moreOptions.length})
                              </button>
                              {showOtherOptions && (
                                <div className="cr-options compact-list" role="radiogroup" aria-label="Other options">
                                  {moreOptions.map((option) => {
                                    const selected = pickedOption === option.id
                                    const selectable = pending && !busy
                                    return (
                                      <div
                                        key={option.id}
                                        role="radio"
                                        tabIndex={selectable ? 0 : -1}
                                        aria-checked={selected}
                                        className={`cr-option compact${selected ? " selected" : ""}${!selectable ? " disabled" : ""}`}
                                        onClick={() => { if (selectable) setPickedOption(option.id) }}
                                      >
                                        <div className="cr-option-top">
                                          <strong>{option.lineName ? `${option.lineName} · ${option.title}` : option.title}</strong>
                                        </div>
                                        <div className="cr-metrics">
                                          <div className="cr-metric">
                                            <span className="cr-metric-label">Price</span>
                                            <span className="cr-metric-value price">{option.priceLabel}</span>
                                          </div>
                                          <div className="cr-metric">
                                            <span className="cr-metric-label">Time</span>
                                            <span className="cr-metric-value time">{option.timeLabel}</span>
                                          </div>
                                        </div>
                                        {option.verdict && <p className="cr-verdict">{option.verdict}</p>}
                                        {option.bookUrl && (
                                          <a className="cr-book" href={option.bookUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                            Book
                                          </a>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )}

                      {pending && draftOption && bookingFields.length > 0 && (
                        <section id="cr-booking-draft" className="cr-booking cr-booking-draft" aria-label="Booking draft">
                          <div className="cr-booking-head">
                            <h3>Booking draft</h3>
                            <p className="cr-draft-badge">Prefilled by agent · check before booking</p>
                            <p>
                              For <b>{draftOption.lineName ? `${draftOption.lineName} · ` : ""}{draftOption.title}</b>.
                              Edit fields, then <b>Copy &amp; open</b> — paste into the carrier site. Agent never books and never contacts the paying customer.
                            </p>
                          </div>
                          <div className="cr-booking-grid">
                            {bookingFields.map((field) => (
                              <label key={field.key} className="cr-booking-field" htmlFor={`draft-${field.key}`}>
                                <span className="cr-booking-label">
                                  {field.label}
                                  {field.required ? " *" : ""}
                                </span>
                                <input
                                  id={`draft-${field.key}`}
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
                            <button
                              type="button"
                              className="cr-primary"
                              data-testid="copy-open-draft"
                              disabled={busy || !draftOption.bookUrl}
                              onClick={() => void copyAndOpenDraft()}
                            >
                              Copy &amp; open
                            </button>
                            {draftOption.bookUrl && (
                              <a className="cr-book cr-book-secondary" href={draftOption.bookUrl} target="_blank" rel="noopener noreferrer">
                                Book link only
                              </a>
                            )}
                            {draftCopied && <span className="cr-booking-saved">Copied — paste on the booking site.</span>}
                          </div>
                        </section>
                      )}

                      <p className="cr-ops-note">
                        <b>Ops:</b> Review the <b>Booking draft</b>, use <b>Copy &amp; open</b>, complete the purchase yourself, then <b>Approve</b>.
                        The agent never books and never contacts the paying customer.
                      </p>
                    </section>

                    <footer id="cr-approve" className="cr-approve">
                      {run.status === "approved" && chosenOption && (
                        <p className="cr-result ok">
                          Approved: {chosenOption.title} · {chosenOption.priceLabel} · {chosenOption.timeLabel}
                          {" · left the attention queue"}
                        </p>
                      )}
                      {run.status === "changed" && !pending && (
                        <p className="cr-result warn">Changed by ops{run.changeNote ? ` — ${run.changeNote}` : ""}</p>
                      )}
                      {pending && (
                        <>
                          <div className="cr-approve-row">
                            <button
                              type="button"
                              className="cr-primary"
                              data-testid="approve-decision"
                              disabled={busy}
                              title={pickedOption ? "Approve selected option" : "Select an option above, then Approve"}
                              onClick={() => void decide("approved")}
                            >
                              {busy ? "Saving…" : "Approve"}
                            </button>
                            <button type="button" className="cr-ghost" data-testid="change-decision" disabled={busy} onClick={() => setShowChange((v) => !v)}>
                              Change
                            </button>
                          </div>
                          {!pickedOption && (
                            <p className="cr-approve-hint" role="status">Select an option above — Approve stays clickable and will explain if something is missing.</p>
                          )}
                          {showChange && (
                            <div className="cr-change">
                              <label htmlFor="change-note">What should the agent try instead?</label>
                              <textarea
                                id="change-note"
                                rows={3}
                                value={changeNote}
                                onChange={(event) => setChangeNote(event.target.value)}
                                placeholder="e.g. Prefer cheapest ferry / tow to workshop / customer arranges own recovery."
                              />
                              <button type="button" className="cr-primary" disabled={busy || !changeNote.trim()} onClick={() => void decide("changed")}>
                                Re-run with this note
                              </button>
                              <p className="cr-change-hint">Saves your note, re-runs the agent, and shows a new pending proposal.</p>
                            </div>
                          )}
                        </>
                      )}
                    </footer>

                    {run.status === "approved" && chosenOption && (
                      <section id="cr-booking-panel" className="cr-booking" aria-label="Ops next steps">
                        <div className="cr-booking-head">
                          <h3>Next for ops</h3>
                          <ol className="cr-next-steps">
                            <li>
                              <b>Book</b>
                              {chosenOption.bookUrl ? (
                                <>
                                  {" — "}
                                  <a href={chosenOption.bookUrl} target="_blank" rel="noopener noreferrer" className="cr-inline-link">
                                    {chosenOption.kind === "recovery" ? "open ADAC roadside-assistance info" : "open carrier Book link"}
                                  </a>
                                  {" and complete the purchase yourself"}
                                </>
                              ) : (
                                " — complete the booking on the provider site yourself"
                              )}
                              . Agent never books.
                            </li>
                            <li>
                              <b>Review draft</b> below (agent-prefilled). Adjust if needed, then save.
                            </li>
                            <li>
                              <b>{isTowCase || chosenOption.kind === "recovery" ? "Call the dealer / customer" : "Update the dealer"}</b>
                              {" — a person sends the customer message. Agent must not contact the paying customer."}
                            </li>
                          </ol>
                        </div>
                        {bookingFields.length > 0 && (
                          <>
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
                          </>
                        )}
                      </section>
                    )}

                    <details className="cr-secondary">
                      <summary>Full narrative and all facts</summary>
                      <div className="cr-secondary-body">
                        <section className="cr-block">
                          <h3>What happened</h3>
                          <p className="cr-lead">{run.decision.happened}</p>
                        </section>
                        <section className="cr-block">
                          <h3>All facts with sources</h3>
                          <ul className="cr-facts">
                            {run.decision.facts.slice(0, 12).map((fact, index) => (
                              <li key={`${fact.label}-${index}`}>
                                <div>
                                  <strong>{fact.label}</strong>
                                  <p>{fact.value}</p>
                                </div>
                                <span className="cr-source" title={fact.source}>
                                  {factSourceLabel(fact.source, fact.sourceKind)}
                                </span>
                              </li>
                            ))}
                          </ul>
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

      {showUrgencyExplainer && (
        <div
          className="cr-urgency-overlay"
          role="presentation"
          onClick={() => setShowUrgencyExplainer(false)}
        >
          <div
            className="cr-urgency-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cr-urgency-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="cr-urgency-dialog-head">
              <h2 id="cr-urgency-title">How urgency is scored</h2>
              <button
                type="button"
                className="cr-ghost"
                onClick={() => setShowUrgencyExplainer(false)}
              >
                Close
              </button>
            </header>
            <p className="cr-urgency-lead">
              Queue priority is rule-based — no model involved. Cases sort P1 → P2 → P3, least slack first inside a level, oldest raised on ties. P2 escalates to P1 when slack is under 1 hour.
            </p>
            <ol className="cr-urgency-rules">
              {URGENCY_RULES.map((rule) => (
                <li key={rule.class}>
                  <span className={`cr-urgency-chip class-${rule.class}`}>{rule.class}</span>
                  <div>
                    <strong>{rule.title}</strong>
                    <p>{rule.when}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="cr-urgency-note">
              Every attention case (including P3) is processed in the background as soon as it exists. Opening a card shows the stored decision — or “Agent working” with tool calls if a run is still in flight. Refresh does not re-run cached proposals.
            </p>
          </div>
        </div>
      )}
    </AppFrame>
  )
}
