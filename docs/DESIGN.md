# Talos design

Status: draft for the research/design deliverable (week of 2026-08-11).
Decisions below marked DECIDED came out of the architecture sessions; everything
else is an open question for the spike.

## 1. Components

Two deployables, cleanly split like Oracle's relay/worker:

**Control plane** — thin task API + registry. No browser code, ever.
Owns: task state machine, pools, machines, profiles, handoff links, webhooks.
State machine (Oracle-derived):

```
submitted -> claimed (lease) -> running (heartbeat)
          -> needs_input | handoff | completed | failed
expired lease -> requeued (front of queue, created_at preserved)
```

**Worker daemon** — runs on every pool machine. Splits into:

- generic runtime (DECIDED): outbound connection (WS or long-poll; works behind
  NAT), claim/lease/heartbeat, artifact upload, live-view stream, input relay,
  masking + handoff policy
- executor plugin (DECIDED): `BrowserExecutor` (Playwright/CDP) now;
  `ComputerExecutor` (ScreenCaptureKit + CGEvent / SendInput + UIA / xdotool) later

## 2. Computer-use forward compatibility (DECIDED)

1. Task API carries a capability-neutral `kind` (`browse` now, `computer_use`
   later); the contract never leaks URLs or DOM.
2. Runtime/executor split as above; masking and handoff live in the runtime so the
   payment discipline carries to desktop automation unchanged.
3. Action protocol modeled on computer-use primitives — `screenshot`, `click(x,y)`,
   `type`, `key`, `scroll`, `wait` — with browser-only DOM accelerators
   (act-on-a11y-node, extract-structured-DOM, navigate) as typed extensions.
   The LLM agent loop is written once against the base protocol.
4. Live view is pixels + input relay (CDP screencast now, OS capture later).
   Never build a DOM-based viewer.
5. Pools/machines carry capability tags; `computer_use: true` requires explicit
   enrollment (dedicated machines / VMs only) and a distinct NyxID approval class.

## 3. Pools and machines (DECIDED)

- Pool tiers mirror Oracle pool visibility: private (user's own device),
  org (e.g. office Mac minis), platform (hosted fleet). Local-vs-remote is just
  pool selection.
- Machines authenticate with a rotatable pool worker token; outbound-only.
- Capability tags: os, region, residential_ip, headed_display, browser,
  computer_use. Scheduler matches task requirements to tags + capacity.
- Real heterogeneous machines are a feature: residential IPs + genuine hardware
  fingerprints beat datacenter fleets against anti-bot systems.

## 4. Profiles (DECIDED)

- A profile is opaque per-user workspace state (browser profile dir today).
- Pinned sticky to the machine where login happened; scheduler prefers that
  machine with node-routing-style failover; encrypted backup to object storage
  for migration. No free profile syncing (cookie-theft surface, fingerprint
  inconsistency).
- One concurrent session per profile (lock).
- Site login: NyxID connect link -> short-lived live view of a fresh session on
  that profile -> user logs in themselves. Credentials never typed into chat.

## 5. Payment (DECIDED)

Talos never handles payment data. The workflow drives to checkout, holds the
session, requests a handoff: single-use hosted link (NyxID connect-link
machinery) -> user sees the live checkout view -> confirms merchant-saved payment
method or enters card directly -> 3DS goes to the user's own banking app.
During handoff the runtime pauses agent control and suppresses DOM capture,
screenshots, and logging. No vault, no card issuing, no KYC, no PCI scope.

## 6. Task API sketch

```
POST /v1/tasks                {kind, goal, site_hint?, profile_id?, constraints{budget,deadline}, mode, callback}
GET  /v1/tasks/{id}           status + structured findings (schema'd, not prose) + artifacts
POST /v1/tasks/{id}/input     {kind: choice|text|otp, value}     # from human_input / secure_input
POST /v1/tasks/{id}/handoff   -> {handoff_url, expires}          # pauses agent, masks capture
POST /v1/tasks/{id}/cancel
POST /v1/profiles/{id}/login-link
```

Webhooks (signed for NyxID trigger ingress): `task.state_changed`,
`task.needs_input`, `task.handoff_requested`, `task.completed`.

Identity: tasks map to NyxID user via propagated identity on the proxied request
(X-NyxID-Identity-Token); an agent key can never browse with another user's
profile.

## 7. Open questions (this week's spike)

1. Agent loop: wrap (Stagehand TS / browser-use Python) vs extend the Oracle CDP
   worker with our own act loop. Spike both on a real flight search read-only
   task; tiebreak favors in-house because masking/handoff cut through the loop.
2. Live view transport: CDP screencast vs WebRTC; input-relay latency budget.
3. Structured findings schema: per-task-template result schemas vs generic
   findings envelope.
4. Where site-specific playbooks live: prompt-only, or Ornn skills the executor
   pulls per site.
5. LLM routing: worker calls through the NyxID /llm gateway (preferred: brokered,
   billed) — confirm latency is acceptable for the act loop.

## 8. Phasing

- Phase 0 (this week): spikes + this design doc + decision memo.
- Phase 1: control plane + one worker + catalog registration; Aevatar workflow
  submits a read-only search, results return via trigger ingress. No logins.
- Phase 2: persistent profiles + connect-link login + live view.
- Phase 3: payment handoff + masking, cancellation, per-domain allowlists,
  anti-bot posture review.
- Future: ComputerExecutor + computer_use enrollment/approval class.

Phase 1 is deliberately "Oracle with a different task kind" — distribution and
fleet mechanics are a pattern already run in production; the genuinely new work
is the agent loop, the profile store, and the live handoff view.
