# Talos Deployment

## Prerequisites

- Node.js 22 for workers that run directly on real hardware.
- Docker 24+ and a registry for building and pushing the control-plane and platform-worker images.
- MongoDB 7 or newer. Use MongoDB Atlas or an operator such as the MongoDB Community Operator for production. `deploy/k8s/mongodb.example.yaml` is for development/testing only.
- NyxID JWT verification settings: `TALOS_NYXID_JWT_PUBLIC_KEY` or `TALOS_NYXID_JWKS_URL`, `TALOS_NYXID_ISSUER`, and `TALOS_NYXID_AUDIENCE`. The development stub is only for local testing; see [IMPLEMENTATION.md](IMPLEMENTATION.md).

Required control-plane secrets are `TALOS_WEBHOOK_SECRET`, `TALOS_ADMIN_TOKEN`, `TALOS_DATABASE_URL`, and the NyxID JWT settings for production. When the database URL is unset, Talos starts with an in-memory repository and logs a warning that state is ephemeral.

When `TALOS_DATABASE_URL` is set, the control plane automatically creates its indexes through `MongoRepository.initialize()` before it starts listening. The runtime database user needs `createIndex` rights during startup. Operators who restrict runtime permissions can pre-create the indexes with an administrative user, then run Talos with credentials limited to normal reads and writes.

## Build and Push

Run from the repository root:

```sh
docker build -f control-plane/Dockerfile -t registry.example/talos-control-plane:0.1.0 .
docker build -f worker/Dockerfile -t registry.example/talos-worker:0.1.0 .
docker push registry.example/talos-control-plane:0.1.0
docker push registry.example/talos-worker:0.1.0
```

The worker image is for Linux platform-pool workers and includes Playwright browsers. Private and org pool machines, especially those requiring headed display, residential IPs, or computer-use capabilities, run the daemon directly with Node on the real macOS/Windows/Linux machine rather than in Kubernetes.

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

Workers need only outbound HTTPS access when NyxID fronts the worker surface. Create a separate catalog entry such as `talos-worker` that points to the private Talos control-plane service, with authentication `none` and `identity_propagation_mode: none`. Add anonymous endpoint rules for `POST /v1/worker/**`, `GET /v1/worker/**`, and `GET /healthz`. Users pass `https://nyxid.example.com/public/s/talos-worker` as the control-plane URL to `talos-worker init`; the worker preserves the catalog prefix on every request.

NyxID strips `Authorization` on this public route but forwards `X-Talos-*`. Workers send both `Authorization: Bearer` for direct deployments and `X-Talos-Worker-Token` for the public proxy. Talos still binds the token to `X-Talos-Machine-Id` and requires `X-Talos-Worker-Id`; the catalog entry does not replace Talos authentication. When both token carriers are present, `X-Talos-Worker-Token` takes precedence.

Set anonymous quotas for the expected machine count before rollout. A 20-second heartbeat alone generates about 4,320 requests per machine per day, and NyxID counts anonymous requests before Talos token validation. Allow additional capacity for claim polling, inputs, artifacts, and task results.

## Scaling Constraint

Run exactly one control-plane replica in this phase. MongoDB provides durability, but claim and lease requeue transitions are not yet transactionally safe across multiple replicas. A future follow-up must use `findOneAndUpdate`-based atomic claim and capacity updates before horizontal scaling is enabled. The deployment therefore uses `replicas: 1` and `strategy: Recreate`.
