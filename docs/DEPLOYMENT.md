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

## Kubernetes Apply Order

1. Replace placeholders in `deploy/k8s/secret.example.yaml` and apply `namespace.yaml` followed by the secret.
2. Apply `control-plane-deployment.yaml` and `control-plane-service.yaml`, using the image tags you pushed.
3. For development only, apply `mongodb.example.yaml`; production should point `TALOS_DATABASE_URL` at MongoDB Atlas or an operator-managed cluster.
4. Optionally configure `ingress.example.yaml` after replacing its host and TLS placeholders.
5. Register a platform machine with the admin API, create a Secret named `talos-worker-token` containing `TALOS_WORKER_TOKEN`, set `TALOS_MACHINE_ID`, and apply `worker.example.yaml`.

`deploy/k8s/kustomization.yaml` provides the base ordering. Example and ingress/worker resources are commented out until their placeholders are replaced.

## Fleet Registration

Platform pools, cross-user profiles, and initial machine enrollment use the `X-Talos-Admin-Token` routes. Users can enroll their own private or org fleet without platform-admin involvement using the NyxID-authenticated `POST /v1/pools`, `POST /v1/pools/{id}/machines`, `POST /v1/machines/{id}/rotate-token`, and `POST /v1/profiles` routes. Pool owners share org pools by setting group slugs in `shared_with_groups`; members submit tasks with `pool_id` using their personal NyxID keys. Submit tasks with `pool_id` to select a local/private or remote/platform pool. An org-owned API key also works because `sub` is treated as the opaque owner id.

Register the service base URL in the NyxID catalog and set `openapi_spec_url` to `http://talos-control-plane.talos.svc.cluster.local/openapi.json`. The control plane also serves the source YAML at `/openapi.yaml`; `/healthz` remains the Kubernetes probe. These unauthenticated metadata endpoints are intentionally omitted from the catalog operations.

## Scaling Constraint

Run exactly one control-plane replica in this phase. MongoDB provides durability, but claim and lease requeue transitions are not yet transactionally safe across multiple replicas. A future follow-up must use `findOneAndUpdate`-based atomic claim and capacity updates before horizontal scaling is enabled. The deployment therefore uses `replicas: 1` and `strategy: Recreate`.
