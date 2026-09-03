# Talos Deployment

## Prerequisites

- Node.js 22 for workers that run directly on real hardware.
- Docker 24+ and a registry for building and pushing the control-plane and platform-worker images.
- MongoDB 7 or newer. Use MongoDB Atlas or an operator such as the MongoDB Community Operator for production. `deploy/k8s/mongodb.example.yaml` is for development/testing only.
- NyxID JWT verification settings: `TALOS_NYXID_JWT_PUBLIC_KEY` or `TALOS_NYXID_JWKS_URL`, `TALOS_NYXID_ISSUER`, and `TALOS_NYXID_AUDIENCE`. The development stub is only for local testing; see [IMPLEMENTATION.md](IMPLEMENTATION.md).

Required control-plane secrets are `TALOS_WEBHOOK_SECRET`, `TALOS_ADMIN_TOKEN`, `TALOS_DATABASE_URL`, and the NyxID JWT settings for production. Testing deployments must also set a persistent PEM-encoded Ed25519 private key in `TALOS_TESTING_CLAIM_PRIVATE_KEY`; `TALOS_TESTING_CLAIM_KEY_ID` selects the stable verification-key identifier advertised in signed current-claim and reconcile-closure envelopes. Provision the corresponding public key to the Local QA Runtime trust store. `TALOS_TESTING_PLACEMENT_VERIFIER` must contain a strict `talos.testing-placement-verifier/v1` JSON document that pins each approved caller to one complete PQL/Source/Plan/Environment Profile/Testing Package input set for the first canary fixture. `TALOS_TESTING_PLACEMENT_POLICY` must contain a strict `talos.testing-placement-policy/v1` JSON document whose rules bind the verified repository and Environment Profile to an allowlisted canary pool plus exact execution-policy, budgets, and Testing Package identities. Testing submit fails closed when either contract is absent or no entry matches; callers cannot supply pool or machine IDs. When the claim key is unset, Talos logs a warning and generates a development-only ephemeral key whose signatures do not survive restart. When the database URL is unset, Talos starts with an in-memory repository and logs a warning that state is ephemeral.

Testing admission is enabled only when the embedding control-plane process injects the complete Authorization, Runtime-fact verifier, Cleanup verifier, and external schema-authority provider set together with the persistent claim key and placement dependencies. A partial or absent provider set keeps `admission_availability=unavailable` and rejects new QARuns before persistence. The standard process entrypoint does not construct temporary providers; until Issue #12's formal provider contracts are available it remains non-admitting even if placement JSON is configured. Existing QARuns remain readable, cancellable, and idempotently replayable during dependency degradation.

The control-plane, worker, and shared Testing Protocol runtime distributions are built from production-only TypeScript configurations. They exclude tests, `src/test-support`, and the PQL contract-fixture generator. The control-plane image copies only `specs/talos-openapi.yaml`, not committed contract fixtures. CI extracts both final images and verifies every Talos-owned runtime package, package entrypoint, and specs surface against production sources while rejecting test paths and test authority markers. Test-only schema identities and provider fixtures are never packaged as production authority material.

When `TALOS_DATABASE_URL` is set, the control plane automatically creates its indexes through `MongoRepository.initialize()` before it starts listening. The runtime database user needs `createIndex` rights during startup. Operators who restrict runtime permissions can pre-create the indexes with an administrative user, then run Talos with credentials limited to normal reads and writes.

Repository contract tests must execute against real MongoDB semantics. `npm run test:mongo-contract` uses `TALOS_TEST_MONGODB_URL` when set; otherwise it starts the pinned MongoDB 7.0.14 `mongodb-memory-server` binary, matching the production minimum major while remaining compatible with supported development hosts. Setup includes a bounded connection preflight, and binary startup or connection failure fails the suite rather than substituting the in-memory repository or reporting a passing skip. External test databases use random `talos_test_*` names; cleanup attempts to drop only the database created by that harness, including after partial initialization, and always closes the client.

## Build and Push

Run from the repository root:

```sh
docker build -f control-plane/Dockerfile -t registry.example/talos-control-plane:0.1.0 .
docker build -f worker/Dockerfile -t registry.example/talos-worker:0.1.0 .
docker push registry.example/talos-control-plane:0.1.0
docker push registry.example/talos-worker:0.1.0
```

The worker image is for Linux platform-pool workers and includes Playwright browsers. Private and org pool machines, especially those requiring headed display, residential IPs, or computer-use capabilities, run the daemon directly with Node on the real macOS/Windows/Linux machine rather than in Kubernetes.

Testing workers use a different execution boundary. `talos-worker` contains the fixed `TestingExecutor`, but the Local QA Runtime is a separately authenticated loopback service and owns environment, Chrome, local effects, journal, and cleanup. Configure the four `TALOS_TESTING_RUNTIME_*` / `TALOS_TESTING_AUTHORIZATION_RESOLVER_*` settings documented in [WORKER.md](WORKER.md) only when both consumer services are available. Hosted authorization ownership remains decision-pending; Talos freezes and validates the consumer port but does not become the signer.

Testing capacity release after local acceptance also requires an authority-backed cleanup verifier. A deployment that enables Testing must inject a `TestingCleanupReceiptVerifier` into `createControlPlane`; Talos has no built-in production verifier. Without one, a structurally valid CleanupReceipt cannot settle `cleanup_outcome=complete|not_required`: terminal commit fails closed, and the machine reservation remains blocked. The verifier must validate the exact run/task/attempt/generation/fence binding before Talos persists its verification record and releases capacity.

The Testing ArtifactStore surface is currently a decision-pending consumer contract only. `@talos/testing-protocol` freezes bounded `prepare/commit/lookup` schemas, and `TestingArtifactDeliveryConsumer` enforces authority, claim, object identity, digest, media, size, and lost-ack lookup boundaries. Talos does not instantiate that consumer in the production control plane, expose an ArtifactStore endpoint, accept Artifact bytes, hold provider credentials, select a storage provider, or assign ownership to `fkst-hosted`. Do not configure a production ArtifactStore adapter until the Hosted owner/authentication/storage decision is accepted.

End-user machines use the GitHub Release installer and `talos-worker` CLI documented in [WORKER.md](WORKER.md). They require Node.js 22+ and can connect through NyxID's public worker rendezvous or directly over a VPN/private network. The release bundle is platform-independent JavaScript; Playwright supplies the machine-specific browser runtime during installation.

## Kubernetes Apply Order

1. Replace placeholders in `deploy/k8s/secret.example.yaml` and apply `namespace.yaml` followed by the secret.
2. Apply `control-plane-deployment.yaml` and `control-plane-service.yaml`, using the image tags you pushed.
3. For development only, apply `mongodb.example.yaml`; production should point `TALOS_DATABASE_URL` at MongoDB Atlas or an operator-managed cluster.
4. Optionally configure `ingress.example.yaml` after replacing its host and TLS placeholders.
5. Register a platform machine with the admin API, create a Secret named `talos-worker-token` containing `TALOS_WORKER_TOKEN`, set `TALOS_MACHINE_ID`, and apply `worker.example.yaml`.

`deploy/k8s/kustomization.yaml` provides the base ordering. Example and ingress/worker resources are commented out until their placeholders are replaced.

## Fleet Registration

Platform pools, cross-user profiles, and initial machine enrollment use the `X-Talos-Admin-Token` routes. Users can enroll their own private or org fleet without platform-admin involvement using the NyxID-authenticated `POST /v1/pools`, `POST /v1/pools/{id}/machines`, `POST /v1/machines/{id}/rotate-token`, and `POST /v1/profiles` routes. Pool owners share org pools by setting group slugs in `shared_with_groups`; members submit tasks with `pool_id` using their personal NyxID keys. Submit tasks with `pool_id` to select a local/private or remote/platform pool. An org-owned API key also works because `sub` is treated as the opaque owner id.

Register the service base URL in the NyxID catalog. The control plane serves its spec at `/openapi.json` (and the source YAML at `/openapi.yaml`); `/healthz` remains the Kubernetes probe. These unauthenticated metadata endpoints are intentionally omitted from the catalog operations.

Hosted-mode NyxID refuses to fetch `openapi_spec_url` targets that resolve to private addresses, so the in-cluster URL cannot be used directly. The working pattern (in production): a second minimal catalog entry `talos-spec` (auth `none`, `identity_propagation_mode: none`) with an admin anonymous-endpoint rule for `GET /openapi.json`, which publishes the live spec at `https://nyxid.example.com/public/s/talos-spec/openapi.json`; set the main `talos` service's `openapi_spec_url` to that public URL. The mirror always serves whatever the deployed pod serves, so the spec never drifts. (Anonymous endpoints cannot live on the main `talos` entry because they require identity propagation `none`, while `talos` uses `jwt`.)

## Public Worker Rendezvous

Workers need only outbound HTTPS access when NyxID fronts the worker surface. Create a separate catalog entry such as `talos-worker` that points to the private Talos control-plane service, with authentication `none` and `identity_propagation_mode: none`. Add anonymous endpoint rules for `POST /v1/worker/**`, `GET /v1/worker/**`, `POST /v1/testing/claims/**/resolve`, and `GET /healthz`. The Runtime resolver route returns only a short-lived, nonce-bound signed currentness statement and never a raw lease token. Users pass `https://nyxid.example.com/public/s/talos-worker` as the control-plane URL to `talos-worker init`; the worker preserves the catalog prefix on every request.

NyxID strips `Authorization` and all custom `X-Talos-*` headers on this public route. It preserves request bodies, so workers include `worker_token`, `worker_id`, and `machine_id` in every worker POST body. Proxy input polling uses `POST /v1/worker/tasks/{id}/input/poll` with the lease token in the body rather than a query string. Direct deployments retain Bearer and `X-Talos-*` headers for compatibility. Talos gives those direct headers precedence over body credentials, but all carriers use the same timing-safe machine-token validation and task-to-machine binding; the anonymous catalog entry never replaces Talos authentication.

Set anonymous quotas for the expected machine count before rollout. A 20-second heartbeat alone generates about 4,320 requests per machine per day, and NyxID counts anonymous requests before Talos token validation. Each active interactive session polls for actions about once every two seconds by default, or roughly 43,200 requests per day if continuously active. Allow additional capacity for claims, inputs, action results, artifacts, and task results.

NyxID's public per-IP rate limiter is generally the binding constraint before the daily quota, especially when several workers share an egress IP. Talos workers exponentially back off transient action-poll and result-delivery failures and adaptively slow polling after `429` responses. Tune `TALOS_ACTION_POLL_MS` above its 2000 ms default when necessary, and account for heartbeats and claim traffic separately.

Interactive sessions use the same singleton scheduling, leases, pool visibility, profile locks, and MongoDB repository as autonomous tasks. Agent callers use the catalog operations `createSession`, `sendSessionAction`, `getSessionAction`, `getSession`, and `closeSession`; the worker remains outbound-only.

## Scaling Constraint

Run exactly one control-plane replica in this phase. MongoDB provides durability, but claim and lease requeue transitions are not yet transactionally safe across multiple replicas. A future follow-up must use `findOneAndUpdate`-based atomic claim and capacity updates before horizontal scaling is enabled. The deployment therefore uses `replicas: 1` and `strategy: Recreate`.
