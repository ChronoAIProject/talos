import { describe, expect, it } from 'vitest';
import {
  computeTestingCancelRequestDigest,
  digestJson,
  type TestingAuthenticatedTransportContext
} from '@talos/testing-protocol';
import type { ResolvedIdentity } from '../identity.js';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { TESTING_CURSOR_PAGE_RETENTION, TestingRunService } from '../services/testing-run-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { createApiServer } from './server.js';
import {
  provisionTestingPool,
  testTestingPlacementInputVerifier,
  testTestingPlacementPolicy
} from '../test-support/testing-placement.js';
import { testTestingExternalSchemaAuthority } from '../test-support/testing-schema-authority.js';
import { testTestingExecutionDependencyReadiness } from '../test-support/testing-execution-readiness.js';
import {
  testAuthenticatedTransportContext,
  testResolvedIdentity
} from '../test-support/testing-transport.js';

const digest = `sha256:${'a'.repeat(64)}`;
const reference = (schema: string, ref: string) => ({ schema, ref, digest });
const policy = {
  network_scope: 'environment_owned_loopback_exact_origins',
  environment_port_handle_policy: { source: 'current_run_owned_handles', allow_unowned_loopback: false },
  allowed_actions: ['navigate'],
  allowed_evidence_media: ['image/png'],
  secret_refs: [],
  budgets: { wall_time_ms: 600_000, max_cases: 20, max_actions: 200, max_events: 2_000, max_screenshots: 20, max_screenshot_bytes: 5_242_880, max_json_evidence_bytes: 1_048_576, max_total_artifact_bytes: 52_428_800 }
} as const;
const submitRequest = (runId = 'run-1', key = 'submit-1') => ({
  schema_version: 'talos.testing-tool-request/v1',
  request_id: `request:${runId}`,
  client_correlation_id: `client:${runId}`,
  idempotency_key: key,
  display_goal: 'Verify login redirect',
  inputs: {
    schema_version: 'talos.testing-input-references/v1',
    project_pack_snapshot: reference('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
    test_selection: reference('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
    testing_design_input_set: reference('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-1'),
    source_revision: { repository_id: 'repo-1', exact_revision: '0123456789abcdef0123456789abcdef01234567', ref: 'artifact://source/revision-1', digest },
    structured_plan: reference('testing-structured-plan.v2', 'artifact://plans/plan-1'),
    environment_profile: { ref: 'artifact://environments/environment-1', digest },
    testing_package: { package_id: 'testing-browser-runner', version: '1.0', digest }
  },
  execution_profile: 'local_qa_agent_mvp',
  placement_requirements: { testing_runtime: 'local-qa-mvp/v1' },
  policy_binding: {
    policy: { schema: 'talos.testing-execution-policy/v1', ref: 'talos://policies/testing/policy-1', digest: digestJson(policy) },
    budgets: { schema: 'talos.testing-budgets/v1', ref: 'talos://policies/testing/budgets-1', digest: digestJson(policy.budgets) }
  },
  policy
});

describe('Testing Tool HTTP routes', () => {
  it('serves the five authenticated, idempotent, bounded operations', async () => {
    const repository = new MemoryRepository();
    await provisionTestingPool(repository);
    let now = Date.parse('2026-08-22T00:00:00.000Z');
    const tasks = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const testingRuns = new TestingRunService(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      clock: () => now,
      placementPolicy: testTestingPlacementPolicy(),
      placementInputVerifier: testTestingPlacementInputVerifier(),
      executionDependencyReadiness: testTestingExecutionDependencyReadiness(),
      externalSchemaAuthority: testTestingExternalSchemaAuthority()
    });
    const identities = new Map<string, ResolvedIdentity>([
      ['user:user-1', { userId: 'user-1', groups: [], permissions: [] }],
      ['user:user-2', { userId: 'user-2', groups: [], permissions: [] }]
    ]);
    const server = createApiServer(tasks, repository, {
      testingRunService: testingRuns,
      identityResolver: { resolve: (token) => identities.get(token) },
      clock: () => now
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { 'x-nyxid-identity-token': 'user:user-1', 'content-type': 'application/json' };
    const submitHeaders = (
      token: string,
      runId: string,
      request: unknown,
      authenticatedTransport?: TestingAuthenticatedTransportContext
    ) => {
      identities.set(token, testResolvedIdentity(runId, request, {
        ...(authenticatedTransport === undefined ? {} : { authenticatedTransport })
      }));
      return { ...headers, 'x-nyxid-identity-token': token };
    };

    try {
      const unauthenticatedCapabilities = await fetch(`${base}/v1/tools/testing/capabilities`);
      expect(unauthenticatedCapabilities.status).toBe(401);
      expect(await unauthenticatedCapabilities.json()).toMatchObject({
        error: { code: 'unauthorized', retryable: false }
      });
      const capabilities = await fetch(`${base}/v1/tools/testing/capabilities`, { headers });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({
        schema_version: 'talos.testing-capabilities/v1',
        operations: ['get_capabilities', 'submit', 'get', 'events', 'cancel'],
        scope: 'resolved_identity_visible_pools',
        admission_availability: { status: 'available', reason_code: null },
        task_contracts: ['talos.testing-task/v1'],
        backend_availability: { availability: 'offline', configured_machine_count: 1 },
        runner_packages: [{ package_id: 'testing-browser-runner', version: '1.0', digest }],
        runner_packages_total_count: 1,
        runner_packages_truncated: false,
        external_schema_capabilities: expect.arrayContaining([
          expect.objectContaining({ contract: 'action', owner: 'testing-packages', status: 'available' })
        ]),
        error_contract: { catalog_version: 'talos.testing-error-catalog/v1' }
      });

      const submitUrl = `${base}/v1/tools/testing/runs/run-1`;
      const runOneRequest = submitRequest();
      const missingTransport = await fetch(submitUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(runOneRequest)
      });
      expect(missingTransport.status).toBe(401);
      expect(await missingTransport.json()).toMatchObject({
        error: { code: 'nyxid_transport_context_required', retryable: false }
      });

      const runOneHeaders = submitHeaders('submit:run-1', 'run-1', runOneRequest);
      const submitted = await fetch(submitUrl, {
        method: 'PUT',
        headers: runOneHeaders,
        body: JSON.stringify(runOneRequest)
      });
      expect(submitted.status).toBe(201);
      expect(await submitted.json()).toMatchObject({
        run_id: 'run-1',
        request_id: 'request:run-1',
        client_correlation_id: 'client:run-1',
        replayed: false,
        control_status: 'submitted',
        authenticated_transport: { subject: 'user-1', transport_correlation_id: 'transport:run-1' }
      });
      const replayed = await fetch(submitUrl, {
        method: 'PUT',
        headers: runOneHeaders,
        body: JSON.stringify(runOneRequest)
      });
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toMatchObject({ run_id: 'run-1', replayed: true });

      const snapshotResponse = await fetch(submitUrl, { headers });
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json() as {
        snapshot_digest: string;
        resume_cursor: string;
        request_id: string;
        authenticated_transport: { subject: string };
      };
      expect(snapshot.snapshot_digest).toMatch(/^sha256:/);
      expect(snapshot).toMatchObject({
        request_id: 'request:run-1',
        authenticated_transport: { subject: 'user-1' }
      });

      const firstEvents = await fetch(`${submitUrl}/events?limit=1`, { headers });
      expect(firstEvents.status).toBe(200);
      const firstPage = await firstEvents.json() as { events: Array<{ type: string }>; next_cursor: string };
      expect(firstPage.events.map((event) => event.type)).toEqual(['run.submitted']);

      now += 1_000;
      const unsignedCancel = {
        schema_version: 'talos.testing-cancel-request/v1' as const,
        idempotency_scope: 'talos.testing.cancel:run-1',
        idempotency_key: 'cancel-1',
        reason: 'user_requested' as const
      };
      const cancel = { ...unsignedCancel, canonical_request_digest: computeTestingCancelRequestDigest('run-1', unsignedCancel) };
      const cancelled = await fetch(`${submitUrl}:cancel`, { method: 'POST', headers, body: JSON.stringify(cancel) });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ control_status: 'cancel_requested', already_terminal: false });

      const secondEvents = await fetch(`${submitUrl}/events?cursor=${encodeURIComponent(firstPage.next_cursor)}`, { headers });
      expect((await secondEvents.json() as { events: Array<{ type: string }> }).events.map((event) => event.type))
        .toEqual(['run.cancel_requested']);
      expect((await fetch(submitUrl, { headers: { ...headers, 'x-nyxid-identity-token': 'user:user-2' } })).status).toBe(403);

      const unsafe = await fetch(`${base}/v1/tools/testing/runs/run-unsafe`, {
        method: 'PUT',
        headers: submitHeaders('submit:run-unsafe', 'run-unsafe', submitRequest('run-unsafe', 'unsafe')),
        body: JSON.stringify({ ...submitRequest('run-unsafe', 'unsafe'), pool_id: 'caller-pool' })
      });
      expect(unsafe.status).toBe(400);
      const unsafeError = await unsafe.json();
      expect(unsafeError).toEqual({
        error: { code: 'validation_error', message: 'request failed schema validation', retryable: false }
      });
      expect(JSON.stringify(unsafeError).length).toBeLessThan(256);
      expect(await repository.getTestingRun('run-unsafe')).toBeUndefined();

      const forgedAuditRequest = submitRequest('run-forged-audit', 'forged-audit');
      const forgedAudit = await fetch(`${base}/v1/tools/testing/runs/run-forged-audit`, {
        method: 'PUT',
        headers: submitHeaders('submit:forged-audit', 'run-forged-audit', forgedAuditRequest),
        body: JSON.stringify({ ...forgedAuditRequest, audit_refs: ['nyxid://audit/events/forged'] })
      });
      expect(forgedAudit.status).toBe(400);
      expect(await repository.getTestingRun('run-forged-audit')).toBeUndefined();

      const correlationRequest = submitRequest('run-correlation-mismatch', 'correlation-mismatch');
      const wrongCorrelation = testAuthenticatedTransportContext('run-correlation-mismatch', correlationRequest, {
        verified_client_correlation_id: 'client:other-run'
      });
      const correlationMismatch = await fetch(`${base}/v1/tools/testing/runs/run-correlation-mismatch`, {
        method: 'PUT',
        headers: submitHeaders(
          'submit:correlation-mismatch',
          'run-correlation-mismatch',
          correlationRequest,
          wrongCorrelation
        ),
        body: JSON.stringify(correlationRequest)
      });
      expect(correlationMismatch.status).toBe(401);
      expect(await correlationMismatch.json()).toMatchObject({
        error: { code: 'nyxid_client_correlation_mismatch', retryable: false }
      });

      const digestRequest = submitRequest('run-digest-mismatch', 'digest-mismatch');
      const digestMismatch = await fetch(`${base}/v1/tools/testing/runs/run-digest-mismatch`, {
        method: 'PUT',
        headers: submitHeaders('submit:digest-mismatch', 'run-digest-mismatch', digestRequest),
        body: JSON.stringify({ ...digestRequest, display_goal: 'Altered after NyxID verification' })
      });
      expect(digestMismatch.status).toBe(401);
      expect(await digestMismatch.json()).toMatchObject({ error: { code: 'nyxid_request_digest_mismatch' } });

      const subjectRequest = submitRequest('run-subject-mismatch', 'subject-mismatch');
      const subjectMismatch = await fetch(`${base}/v1/tools/testing/runs/run-subject-mismatch`, {
        method: 'PUT',
        headers: submitHeaders(
          'submit:subject-mismatch',
          'run-subject-mismatch',
          subjectRequest,
          testAuthenticatedTransportContext('run-subject-mismatch', subjectRequest, { subject: 'user-2' })
        ),
        body: JSON.stringify(subjectRequest)
      });
      expect(subjectMismatch.status).toBe(401);
      expect(await subjectMismatch.json()).toMatchObject({ error: { code: 'nyxid_subject_mismatch' } });

      const resyncUrl = `${base}/v1/tools/testing/runs/run-resync`;
      const resyncRequest = submitRequest('run-resync', 'submit-resync');
      expect((await fetch(resyncUrl, {
        method: 'PUT',
        headers: submitHeaders('submit:run-resync', 'run-resync', resyncRequest),
        body: JSON.stringify(resyncRequest)
      })).status).toBe(201);
      const resyncSnapshot = await (await fetch(resyncUrl, { headers })).json() as { resume_cursor: string };
      const emptyPage = await (await fetch(
        `${resyncUrl}/events?cursor=${encodeURIComponent(resyncSnapshot.resume_cursor)}`,
        { headers }
      )).json() as { next_cursor: string };
      const run = await repository.getTestingRun('run-resync');
      const cachedPage = Object.values(run?.cursorPages ?? {})[0];
      if (run === undefined || cachedPage === undefined) throw new Error('cursor page fixture missing');
      const saturatedPages = Object.fromEntries(Array.from(
        { length: TESTING_CURSOR_PAGE_RETENTION },
        (_, index) => [`cache-${index}`, cachedPage]
      ));
      expect(await repository.replaceTestingRun({
        ...run,
        recordVersion: run.recordVersion + 1,
        cursorPages: saturatedPages
      }, run.recordVersion)).toBe(true);
      const expired = await fetch(
        `${resyncUrl}/events?cursor=${encodeURIComponent(emptyPage.next_cursor)}`,
        { headers }
      );
      expect(expired.status).toBe(410);
      expect(await expired.json()).toMatchObject({
        error: {
          code: 'cursor_expired',
          retryable: true,
          replacement_cursor: expect.any(String),
          snapshot_ref: expect.stringMatching(/^talos:\/\//),
          snapshot_version: 2,
          snapshot_digest: expect.stringMatching(/^sha256:/)
        }
      });
    } finally {
      server.close();
    }
  });
});
