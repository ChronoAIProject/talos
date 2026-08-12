# Talos

Machine operator service for the NyxID x Aevatar platform. Browser automation first
(flight booking, food delivery, any site without an API), full computer use later —
the browser is the first executor, not the architecture.

Working name: "Talos" (the bronze automaton). Capability-neutral on purpose — do not
rename anything here "browser-operator"; the browser is one executor plugin.

## What it is

A standalone service (never part of the NyxID codebase) that:

- exposes an async task API following the Oracle relay pattern:
  submit -> worker claim -> lease heartbeat -> result -> webhook
- executes tasks on pools of real machines (macOS / Windows / Linux) running an
  outbound-connecting worker daemon
- is registered in the NyxID catalog with an OpenAPI spec, so Aevatar workflows can
  admit its operations as typed `capability.nyxid_operation` steps and NyxID chat can
  reach it through `nyxid_proxy`
- never handles payment data: checkout finishes via a hosted handoff link where the
  user pays the merchant directly (NyxID connect-link machinery)

## Relationship to the platform

- NyxID: brokered auth + identity propagation, approvals, trigger ingress for our
  webhooks, connect links for site login and payment handoff, audit
- Aevatar: purchase/errand workflows submit tasks and suspend on `wait_signal`
- Managed Codex: a codex agent can chain tasks to Talos through the NyxID proxy
- Ornn: task playbooks (site-specific know-how) publishable as versioned skills
- Oracle (Lexa): the proven ancestor of the worker protocol; the CDP worker is the
  starting point for our worker daemon

Architecture overview page (diagrams, decisions, weekly deliverables):
`../nyxid-aevatar-architecture.html`

## Layout (planned)

- `docs/` — design docs (start with DESIGN.md)
- `control-plane/` — task API + pool/profile registry (Node/TypeScript)
- `worker/` — worker daemon: generic runtime + executor plugins (Node/TypeScript)
- `specs/` — OpenAPI spec for NyxID catalog registration

## Status

Research and design phase. See `docs/DESIGN.md` for the full design and open
questions; nothing is implemented yet.
