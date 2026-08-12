# Phase 1 Implementation

The control plane is split by domain under `control-plane/src`: task state and lease transitions live in `services/task-service.ts`, machine capability matching in `services/scheduler.ts`, profile ownership and the one-session lock in `services/profile-lock.ts`, and signed webhook construction in `services/webhook-signer.ts`. `storage/repository.ts` is the async persistence boundary; `memory-repository.ts` is the Phase 1 implementation. `http/server.ts` is the Node HTTP adapter and validates all request bodies with zod schemas.

The worker package keeps the Oracle-style runtime independent from an executor. `runtime/client.ts` handles claim, heartbeat, result, artifact, and input relay; the executor only sees typed computer-use actions from `protocol/actions.ts`. `runtime/policy.ts` is the masking/handoff policy hook. `executor/browser-executor.ts` adapts Playwright/CDP and contains only browser execution logic.

The public API contract is catalog-ready at `specs/talos-openapi.yaml`. Login-link and handoff machinery that depends on Phase 2/3 NyxID connect-link infrastructure returns a documented `not_implemented` error while preserving the endpoint and state validation.
