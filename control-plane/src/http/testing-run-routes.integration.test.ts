import { describe, expect, it } from 'vitest';
import { computeTestingCancelRequestDigest, digestJson } from '@talos/testing-protocol';
import { ProfileLockService } from '../services/profile-lock.js';
import { Scheduler } from '../services/scheduler.js';
import { TaskService } from '../services/task-service.js';
import { TESTING_CURSOR_PAGE_RETENTION, TestingRunService } from '../services/testing-run-service.js';
import { WebhookSigner } from '../services/webhook-signer.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { createApiServer } from './server.js';

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
const submitRequest = {
  schema_version: 'talos.testing-tool-request/v1',
  idempotency_key: 'submit-1',
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
};

describe('Testing Tool HTTP routes', () => {
  it('serves the five authenticated, idempotent, bounded operations', async () => {
    const repository = new MemoryRepository();
    let now = Date.parse('2026-08-22T00:00:00.000Z');
    const tasks = new TaskService(repository, new Scheduler(repository), new ProfileLockService(repository), new WebhookSigner('webhook-secret-1234'));
    const testingRuns = new TestingRunService(repository, {
      cursorSecret: 'testing-cursor-secret-123456',
      clock: () => now
    });
    const server = createApiServer(tasks, repository, { testingRunService: testingRuns, clock: () => now });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { 'x-nyxid-identity-token': 'user:user-1', 'content-type': 'application/json' };

    try {
      expect((await fetch(`${base}/v1/tools/testing/capabilities`)).status).toBe(401);
      const capabilities = await fetch(`${base}/v1/tools/testing/capabilities`, { headers });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({
        schema_version: 'talos.testing-capabilities/v1',
        task_contracts: ['talos.testing-task/v1']
      });

      const submitUrl = `${base}/v1/tools/testing/runs/run-1`;
      const submitted = await fetch(submitUrl, { method: 'PUT', headers, body: JSON.stringify(submitRequest) });
      expect(submitted.status).toBe(201);
      expect(await submitted.json()).toMatchObject({ run_id: 'run-1', replayed: false, control_status: 'submitted' });
      const replayed = await fetch(submitUrl, { method: 'PUT', headers, body: JSON.stringify(submitRequest) });
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toMatchObject({ run_id: 'run-1', replayed: true });

      const snapshotResponse = await fetch(submitUrl, { headers });
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json() as { snapshot_digest: string; resume_cursor: string };
      expect(snapshot.snapshot_digest).toMatch(/^sha256:/);

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
        headers,
        body: JSON.stringify({ ...submitRequest, idempotency_key: 'unsafe', pool_id: 'caller-pool' })
      });
      expect(unsafe.status).toBe(400);
      expect(await repository.getTestingRun('run-unsafe')).toBeUndefined();

      const resyncUrl = `${base}/v1/tools/testing/runs/run-resync`;
      expect((await fetch(resyncUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...submitRequest, idempotency_key: 'submit-resync' })
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
