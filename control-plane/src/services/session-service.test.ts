import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../storage/memory-repository.js';
import { ProfileLockService } from './profile-lock.js';
import { Scheduler } from './scheduler.js';
import { SessionService } from './session-service.js';
import { TaskService } from './task-service.js';
import { WebhookSigner } from './webhook-signer.js';

const setup = async () => {
  const clock = { value: 1_000 };
  const repository = new MemoryRepository();
  await repository.savePool({ id: 'pool', visibility: 'platform', tags: {} });
  await repository.saveMachine({
    id: 'machine',
    poolId: 'pool',
    tags: { browser: true },
    capacity: 2,
    activeLeases: 0,
    online: true,
    workerTokenHash: 'hash'
  });
  const tasks = new TaskService(
    repository,
    new Scheduler(repository),
    new ProfileLockService(repository),
    new WebhookSigner('test-webhook-secret'),
    { clock: () => clock.value, leaseSeconds: 10 }
  );
  const sessions = new SessionService(tasks, repository, {
    clock: () => clock.value,
    pollIntervalMs: 250,
    sleep: async (milliseconds) => {
      clock.value += milliseconds;
    }
  });
  return { clock, repository, sessions, tasks };
};

describe('session service', () => {
  it('creates an interactive session and closes it while queued', async () => {
    const { repository, sessions } = await setup();
    const created = await sessions.create('user-a', { mode: 'read_only', constraints: {} });

    expect(created).toMatchObject({ status: 'submitted', mode: 'read_only' });
    expect((await repository.getTask(created.id))?.interaction).toBe('interactive');
    expect(await sessions.close(created.id, 'user-a')).toMatchObject({ status: 'completed' });
    await expect(sessions.get(created.id, 'user-b')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('marks a claimed session closing for the worker to observe', async () => {
    const { sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker', 'machine');

    expect(await sessions.close(created.id, 'user-a')).toMatchObject({ status: 'closing' });
    expect(await sessions.pollWorkerAction(created.id, 'worker', claim.leaseToken)).toEqual({ closing: true });
    expect((await tasks.complete(created.id, 'worker', claim.leaseToken, 'completed', [])).status).toBe('completed');
  });

  it('enforces read-only mode and exactly one action in flight', async () => {
    const { repository, sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'read_only', constraints: {} });
    await tasks.claim('worker', 'machine');

    await expect(sessions.sendAction(created.id, 'user-a', { type: 'type', text: 'secret' }, 0))
      .rejects.toMatchObject({ code: 'mode_forbidden' });
    const first = await sessions.sendAction(created.id, 'user-a', { type: 'screenshot', format: 'jpeg', quality: 70 }, 0);
    expect(first.status).toBe('pending');
    await expect(sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 1 }, 0))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.getTask(created.id))?.pendingActionId).toBe(first.action_id);
    await sessions.close(created.id, 'user-a');
    await expect(sessions.getAction(created.id, first.action_id, 'user-a', 0)).resolves.toMatchObject({
      status: 'completed',
      result: { error: { code: 'session_closed' } }
    });
  });

  it('long-polls until a late worker result and correlates action ids', async () => {
    const { clock, repository, sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker', 'machine');
    const pending = await sessions.sendAction(created.id, 'user-a', { type: 'navigate', url: 'https://example.com' }, 0);
    const action = await sessions.pollWorkerAction(created.id, 'worker', claim.leaseToken);
    expect(action.action?.id).toBe(pending.action_id);

    let sleeps = 0;
    const waiting = new SessionService(tasks, repository, {
      clock: () => clock.value,
      pollIntervalMs: 250,
      sleep: async (milliseconds) => {
        clock.value += milliseconds;
        sleeps += 1;
        if (sleeps === 1) {
          await sessions.saveWorkerResult(
            created.id,
            pending.action_id,
            'worker',
            claim.leaseToken,
            { value: 'loaded' }
          );
        }
      }
    });

    await expect(waiting.getAction(created.id, pending.action_id, 'user-a', 1)).resolves.toEqual({
      action_id: pending.action_id,
      status: 'completed',
      result: { value: 'loaded' }
    });
    await expect(waiting.getAction(created.id, 'action_other', 'user-a', 0))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('accepts the next action once the previous result is observable', async () => {
    const { repository, sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker', 'machine');
    const first = await sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 1 }, 0);
    await sessions.pollWorkerAction(created.id, 'worker', claim.leaseToken);
    await sessions.saveWorkerResult(
      created.id,
      first.action_id,
      'worker',
      claim.leaseToken,
      { value: 'done' }
    );

    await expect(sessions.getAction(created.id, first.action_id, 'user-a', 0)).resolves.toEqual({
      action_id: first.action_id,
      status: 'completed',
      result: { value: 'done' }
    });
    const second = await sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 2 }, 0);
    expect(second.status).toBe('pending');
    expect(second.action_id).not.toBe(first.action_id);
    expect((await repository.getTask(created.id))?.pendingActionId).toBe(second.action_id);
  });

  it('reports a stable conflict when an action result is posted again', async () => {
    const { sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker', 'machine');
    const pending = await sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 1 }, 0);
    await sessions.pollWorkerAction(created.id, 'worker', claim.leaseToken);
    await sessions.saveWorkerResult(
      created.id,
      pending.action_id,
      'worker',
      claim.leaseToken,
      { value: 'done' }
    );

    await expect(sessions.saveWorkerResult(
      created.id,
      pending.action_id,
      'worker',
      claim.leaseToken,
      { value: 'done' }
    )).rejects.toMatchObject({ code: 'action_already_completed', status: 409 });
  });

  it('converges a lost worker acknowledgement after session teardown', async () => {
    const { clock, repository, sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker', 'machine');
    const sent = await sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 1 }, 0);
    await sessions.pollWorkerAction(created.id, 'worker', claim.leaseToken);
    await sessions.saveWorkerResult(created.id, sent.action_id, 'worker', claim.leaseToken, { value: 'winner' });
    await sessions.close(created.id, 'user-a');
    clock.value = 12_000;
    await tasks.expireLeases();
    await expect(sessions.saveWorkerResult(created.id, sent.action_id, 'worker', claim.leaseToken, { value: 'retry' }, 'machine'))
      .rejects.toMatchObject({ code: 'action_already_completed', status: 409 });
    expect((await repository.getSessionActionResult(sent.action_id))?.result).toEqual({ value: 'winner' });
    expect((await repository.getMachine('machine'))?.activeLeases).toBe(0);
  });

  it('classifies a teardown winner as an immutable action completion', async () => {
    const { clock, repository, sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker', 'machine');
    const sent = await sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 1 }, 0);
    await sessions.pollWorkerAction(created.id, 'worker', claim.leaseToken);
    await sessions.close(created.id, 'user-a');
    clock.value = 12_000;
    await tasks.expireLeases();
    await expect(sessions.saveWorkerResult(created.id, sent.action_id, 'worker', claim.leaseToken, { value: 'late' }, 'machine'))
      .rejects.toMatchObject({ code: 'action_already_completed', status: 409 });
    expect((await repository.getSessionActionResult(sent.action_id))?.result).toEqual({ error: { code: 'session_closed', message: 'session closed before the action completed' } });
    expect((await repository.getMachine('machine'))?.activeLeases).toBe(0);
  });

  it('rejects task-only operations and completes a closing session when its lease expires', async () => {
    const { clock, repository, sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker', 'machine');

    await expect(tasks.needsInput(created.id, 'worker', claim.leaseToken)).rejects.toMatchObject({ code: 'conflict' });
    await expect(tasks.getWorkerInput(created.id, 'worker', claim.leaseToken)).rejects.toMatchObject({ code: 'conflict' });
    await expect(tasks.requestHandoff(created.id, 'user-a', 10)).rejects.toMatchObject({ code: 'conflict' });
    await expect(tasks.cancel(created.id, 'user-a')).rejects.toMatchObject({ code: 'conflict' });

    const sent = await sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 1 }, 0);
    await sessions.pollWorkerAction(created.id, 'worker', claim.leaseToken);
    await sessions.close(created.id, 'user-a');
    clock.value = 12_000;
    await tasks.expireLeases();
    expect((await repository.getTask(created.id))?.status).toBe('completed');
    expect((await repository.getMachine('machine'))?.activeLeases).toBe(0);
    expect(await sessions.getAction(created.id, sent.action_id, 'user-a', 0)).toMatchObject({
      status: 'completed',
      result: { error: { code: 'session_closed' } }
    });
  });

  it('returns a dispatched action to pending when an interactive lease is requeued', async () => {
    const { clock, sessions, tasks } = await setup();
    const created = await sessions.create('user-a', { mode: 'act', constraints: {} });
    const claim = await tasks.claim('worker-one', 'machine');
    const sent = await sessions.sendAction(created.id, 'user-a', { type: 'wait', milliseconds: 1 }, 0);
    expect((await sessions.pollWorkerAction(created.id, 'worker-one', claim.leaseToken)).action?.id).toBe(sent.action_id);

    clock.value = 12_000;
    await tasks.expireLeases();
    const replacement = await tasks.claim('worker-two', 'machine');
    expect((await sessions.pollWorkerAction(created.id, 'worker-two', replacement.leaseToken)).action?.id).toBe(sent.action_id);
  });
});
