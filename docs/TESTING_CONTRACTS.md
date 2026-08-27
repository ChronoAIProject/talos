# Talos Testing Tool Contracts

Status: PQL consumer contract candidate for PR #10.

## Public Operations

The formal `talos.testing` API has exactly five operations:

| Operation | HTTP projection | Authority |
| --- | --- | --- |
| `get_capabilities` | `GET /v1/tools/testing/capabilities` | Short-lived, identity-scoped Talos capability projection |
| `submit` | `PUT /v1/tools/testing/runs/{run_id}` | Idempotent QARun admission |
| `get` | `GET /v1/tools/testing/runs/{run_id}` | Current canonical `TestingRunSnapshot` |
| `events` | `GET /v1/tools/testing/runs/{run_id}/events` | Bounded immutable event projection |
| `cancel` | `POST /v1/tools/testing/runs/{run_id}:cancel` | Durable cancel intent and acknowledgement |

There is no public `/result` operation or second terminal write path. The worker-internal
`/v1/worker/testing/runs/{run_id}/result` mutation commits Runtime facts into the same QARun
Snapshot authority; it is not a PQL Testing Tool operation.

## Canonical Terminal Fact

The only canonical terminal result is a digest-valid `talos.testing-run-snapshot/v1` with:

```text
control_status in {completed, failed, cancelled, abandoned}
AND execution_outcome != executing
AND evidence_outcome != staging
AND upload_outcome != pending
AND cleanup_outcome != pending
```

It carries exact inputs, attempt/machine/worker/runtime provenance, verified NyxID transport
lineage, five orthogonal outcomes, a bounded non-authoritative summary, and opaque attempt-bound
CaseResultSet/EvidenceManifest/CleanupReceipt refs, payload digests, and owning-schema digests.
`snapshot_digest` is the single terminal identity. Talos does not create `result_digest` or a
second result identity.

`control_status=completed` means that Talos control has closed. It does not mean a Case passed.
For example, `control_status=completed + upload_outcome=pending` is closed but not canonical
terminal (`terminal=false`). The same Snapshot projection may then advance monotonically to
`uploaded`, `failed`, or `upload_expired` without rerunning product Cases.

## Contract Ownership

| ID | Contract | Authoritative owner | Talos role |
| --- | --- | --- | --- |
| C-01 | `pql.testing-design-input-set.v1` | PQL | Consume opaque ref/digest; never add run transport fields |
| C-02 | TestingPackageManifest / StructuredPlan | Testing Packages owning repo | Verify and forward exact identity/ref/digest |
| C-03 | Capability response | Talos | Publish bounded identity-scoped availability |
| C-04 | QARun wire Request/Accepted | Talos | Own Schema; PQL is requirements source and consumer |
| C-05 | QARun Snapshot/Event/Cursor | Talos | Own canonical serialization and digest rules |
| C-06 | Assignment/Attempt/Lease/Generation/Fence | Talos | Own currentness and stale-writer rejection |
| C-07 | Local QA Request/Acceptance | Local QA Runtime owning repo | Integrate through a non-authoritative consumer adapter validator |
| C-08 | Action/Observation/Assertion/CaseResult/CaseResultSet/Aggregate | Testing Packages owning repo | Validate published schema/package identity and persist opaque refs |
| C-09 | EvidenceManifest/CleanupReceipt | Local QA Runtime owning repo | Verify authority and persist opaque refs/digests |
| C-10 | Canonical terminal `TestingRunSnapshot` constraints | Talos | Own the single canonical terminal projection |
| C-11 | Transport identity/route/authorization/audit envelope | NyxID / authorization authority | Trust only the verified resolver projection |
| C-12 | TestingRunRecord/Validation/Quality/Release Gate | PQL | No Talos authority or implementation |

The Zod types in `testing-protocol/src/testing-runtime.ts` are bounded consumer-side adapter
validators. They are not a publication of Runtime-owned or Testing-Packages-owned authoritative
Schemas. Talos OpenAPI does not inline a hand-maintained second copy of those external Schemas.

As of 2026-08-28, the local Testing Packages owning repo does not publish a cross-repository
Action/Observation/Assertion/CaseResultSet schema manifest with exact IDs, versions, and digests,
and the Local QA Runtime owning repo does not publish an equivalent EvidenceManifest/CleanupReceipt
manifest. `get_capabilities` therefore reports those `upstream_manifest` entries as `unavailable`
with `upstream_schema_manifest_unpublished`. The same injected authority boundary is used by
terminal admission: while an owning manifest is unavailable, Talos rejects terminal refs with
`external_schema_authority_unavailable` and cannot publish a positive canonical terminal Snapshot
that depends on them. A manifest identity mismatch is rejected with
`invalid_external_schema_reference`. Talos must not synthesize identities. Once owners publish
manifests, their adapter can expose and verify exact schema ID/version/digest tuples through this
boundary without copying an authoritative Schema into Talos.

The legacy `result_contracts` strings in capability and terminal ref envelopes identify the current
Talos adapter slots. They do not transfer Schema ownership and are not a substitute for the missing
upstream manifest digest.

## Capability Semantics

`talos.testing-capabilities/v1` includes:

- the five formal operation names;
- `observed_at` and a 30-second `valid_until`;
- execution/runtime/task/result adapter contract identifiers;
- a separate admission readiness fact for placement verifier/policy configuration;
- one bounded backend availability aggregate without pool or machine IDs;
- exact Runner `package_id + version + digest` tuples observed on visible configured machines;
- visible pool/configured machine/online machine/available slot counts;
- Runner package total/truncation metadata when the bounded 64-item projection is incomplete;
- external Schema publication status and authoritative owner;
- stable public error contract/catalog versions and execution/evidence limits.

Availability is advisory and identity-scoped. Available capacity subtracts both generic machine
leases and every durable Testing reservation record, including expired records that have not yet
been state-aware swept or explicitly released. `residual_blocking` reservations remain occupied
until their explicit release proof is persisted. Hardware/package availability is separate from
`admission_availability`, so an unconfigured placement verifier or policy cannot look end-to-end
ready. Capability observation does not reserve capacity and cannot replace submit-time input
verification, placement policy, reservation, or worker/Runtime admission.

## Orthogonal Outcomes

| Dimension | Meaning | Positive-gate values |
| --- | --- | --- |
| `control_status` | Talos control lifecycle closure | `completed` |
| `execution_outcome` | Testing Packages/Runner Case fact | `passed`, with `all_skipped=false` |
| `evidence_outcome` | Runtime evidence settlement | PQL policy-accepted settled value |
| `upload_outcome` | Artifact delivery settlement | `uploaded` or `not_required` |
| `cleanup_outcome` | Runtime cleanup settlement | `complete` or `not_required` |

Assertion failure, Runner error, all-skipped, timeout, terminal blocked, and cancellation remain
distinct. Cleanup failure never rewrites Case assertion facts. Talos exposes the facts required for
PQL validation but does not compute `ProductQualityAssessment` or `ReleaseGateDecision`.

## Correlation And Hop Validation

| Hop | Validates | Does not trust or revalidate |
| --- | --- | --- |
| PQL to Talos admission | PQL `request_id`, `client_correlation_id`, `idempotency_key`; NyxID-authenticated subject, route, authorization, request digest, transport correlation and audit refs | Request-body transport/audit claims |
| Scheduler to worker | Current run/attempt, machine, worker, reservation, lease, generation, fence, signed canonical task payload digest and hop authorization | Raw PQL-to-Talos transport envelope |
| Worker to Local QA Runtime | Runtime audience, operation authorization, current claim, exact source/plan/package bindings | Authority reconstruction or mutation of original NyxID transport facts |

InputSet remains deterministic and reusable. It excludes request, correlation, idempotency and
NyxID transport/audit fields.

The canonical task payload digest covers the task/attempt identity, lease-claim reference and
expiry, frozen inputs, Runner identity, policy/budget refs, Runtime capability and deadline. It
excludes the claim digest itself and the separately authority-verified authorization proof to avoid
recursive authorities. The worker recomputes it before capability lookup, authorization resolution,
or any Runtime call, and requires the recomputed value to match the Talos-signed current claim.

## Public Error Contract

Every HTTP error uses `talos.public-error/v1`:

```json
{"error":{"code":"stable_code","message":"bounded safe text","retryable":false}}
```

Optional bounded details cannot override `code`, `message`, or `retryable`. Retryability means the
same logical operation may be retried after its stated precondition changes; it never authorizes a
stale worker/attempt replay.

Boundary validation uses the fixed public message `request failed schema validation`; Talos does
not reflect an unbounded Zod issue list or caller-controlled paths in public errors.

| Classification | Public code(s) | Retryable |
| --- | --- | --- |
| Invalid JSON/Schema | `invalid_json`, `validation_error` | No |
| Authentication/route access | `unauthorized`, `forbidden`, `not_found`, `nyxid_transport_context_required` | No |
| Digest/identity conflict | `request_digest_mismatch`, `run_identity_conflict`, `idempotency_conflict` | No |
| Invalid/bounded idempotency or cursor input | `invalid_idempotency_scope`, `idempotency_ledger_full`, `invalid_cursor` | No |
| Source/selection/plan/package verification rejected | `testing_placement_inputs_unverified` | No |
| Unsupported or policy-denied capability | `testing_placement_denied` | No |
| No currently eligible configured machine/package | `testing_placement_unavailable` | Yes |
| Placement policy/verifier unavailable | `testing_placement_policy_unavailable`, `testing_placement_verifier_unavailable` | Yes |
| Authorization service unavailable | `testing_authorization_unavailable` | Yes |
| Authorization denied/expired/binding mismatch | `nyxid_authorization_mismatch`, `nyxid_authorization_expired`, `nyxid_*_mismatch` | No |
| Wrong machine/worker/attempt | `stale_testing_machine`, `stale_testing_worker`, `stale_testing_attempt` | No |
| Lease/generation/fence invalid | `invalid_testing_lease`, `testing_lease_expired`, `stale_testing_generation`, `stale_testing_fence` | No |
| Runtime admission fact rejected | `invalid_no_local_acceptance_fact` | No |
| Terminal result invalid/conflicting | `invalid_terminal_projection`, `stale_terminal_binding`, `terminal_commit_conflict` | No |
| Cleanup authority unavailable/rejected | `cleanup_verifier_unavailable` / `invalid_cleanup_receipt` | Yes / No |
| External Schema authority unavailable/rejected | `external_schema_authority_unavailable` / `invalid_external_schema_reference` | Yes / No |
| Event cursor expired | `cursor_expired` plus replacement Snapshot/cursor fields | Yes |
| Optimistic concurrency race | `concurrent_update` | Yes |

Product assertion failure, Runner execution error, evidence incomplete, cleanup failed/incomplete,
timeout, cancel and abandoned are canonical Snapshot outcomes rather than transport failures. This
prevents PQL from confusing a valid failed test fact with an API delivery error.

## Sandbox Fixtures

PQL-consumable fixtures are committed at `specs/testing-contract-fixtures.json`. They are generated
from Talos protocol types by `npm run generate:testing-fixtures` and checked byte-for-byte by tests.
They cover passed, assertion failed, Runner/Runtime error, all-skipped, Evidence incomplete/unavailable,
Cleanup failed/incomplete/unknown, timeout, cancel, terminal blocked, abandoned, upload
failed/expired/pending, authorization, placement, wrong machine/worker, lease/fence/generation,
Runtime admission, package/source/plan mismatch, duplicate submit, duplicate/out-of-order events,
cursor expiry, heartbeat loss, Talos restart, worker/Runtime restart, and conflicting terminal commit.

All fixtures are deterministic, use opaque refs/digests only, carry no credentials, and declare
`side_effects=false`. They do not start a machine, Runtime, browser, process, or network operation.
Their external schema identities are consumer-contract examples accepted only by an explicit
test-only authority; they are not published upstream manifests and cannot configure production
terminal admission.
