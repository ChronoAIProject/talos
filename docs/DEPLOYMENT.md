# Talos Deployment

## Prerequisites

- Node.js 22 for workers that run directly on real hardware.
- Docker 24+ and a registry for building and pushing the control-plane and platform-worker images.
- MongoDB 7 or newer. Use MongoDB Atlas or an operator such as the MongoDB Community Operator for production. `deploy/k8s/mongodb.example.yaml` is for development/testing only.
- A verifying NyxID identity resolver and a production webhook callback host policy. The default `user:<id>` resolver is a development stub; see [IMPLEMENTATION.md](IMPLEMENTATION.md).

Required control-plane secrets are `TALOS_WEBHOOK_SECRET`, `TALOS_ADMIN_TOKEN`, and `TALOS_DATABASE_URL`. When the database URL is unset, Talos starts with an in-memory repository and logs a warning that state is ephemeral.

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

Platform and org pools, cross-user profiles, and initial machine enrollment use the `X-Talos-Admin-Token` routes. Users can enroll their own private fleet without platform-admin involvement using the NyxID-authenticated `POST /v1/pools`, `POST /v1/pools/{id}/machines`, `POST /v1/machines/{id}/rotate-token`, and `POST /v1/profiles` routes. Submit tasks with `pool_id` to select a local/private or remote/platform pool.

Register the OpenAPI document at `specs/talos-openapi.yaml` in the NyxID catalog. `/healthz` is an operational Kubernetes probe and is intentionally omitted from that catalog contract.

## Scaling Constraint

Run exactly one control-plane replica in this phase. MongoDB provides durability, but claim and lease requeue transitions are not yet transactionally safe across multiple replicas. A future follow-up must use `findOneAndUpdate`-based atomic claim and capacity updates before horizontal scaling is enabled. The deployment therefore uses `replicas: 1` and `strategy: Recreate`.
