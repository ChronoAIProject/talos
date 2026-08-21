import { describe, expect, it } from 'vitest';
import {
  assertionResultSchema,
  canonicalJson,
  caseResultSchema,
  cleanupResultSchema,
  computeStructuredPlanDigest,
  evidenceDescriptorSchema,
  isQaRunTransitionAllowed,
  jsonValueSchema,
  qaRunEventBatchSchema,
  qaRunEventSchema,
  qaRunSnapshotSchema,
  structuredPlanSchema,
  testingTaskEventSubmissionSchema,
  testingTaskPayloadSchema,
  testingTaskResultSchema,
  typedTestingActionSchema,
  verifyStructuredPlanDigest,
  type QaErrorInput,
  type TypedTestingActionInput
} from './qa.js';

const artifactDigest = `sha256:${'a'.repeat(64)}`;
const startedAt = '2026-08-21T00:00:00.000Z';
const completedAt = '2026-08-21T00:00:01.000Z';

const planInput = {
  schemaVersion: 1 as const,
  id: 'plan-1',
  name: 'smoke test',
  package: { name: 'pql-web', version: '1.0.0', digest: artifactDigest },
  environment: { name: 'talos-local', version: '1.0.0', digest: artifactDigest },
  cases: [{ id: 'case-1', name: 'home page loads', steps: [{ id: 'step-1', payload: { path: '/' } }] }]
};

const assertionPassed = {
  assertionId: 'assertion-1',
  conclusion: 'passed' as const,
  expected: 'Example',
  actual: 'Example Domain'
};

const casePassed = {
  caseId: 'case-1',
  attempt: 1,
  conclusion: 'passed' as const,
  startedAt,
  completedAt,
  durationMs: 1000,
  assertions: [assertionPassed]
};

const taskContext = {
  schemaVersion: 1 as const,
  runId: 'run-1',
  testingTaskId: 'testing-task-1',
  attempt: 1,
  fencingToken: 'fencing-token-0001'
};

const qaError: QaErrorInput = { code: 'executor_failed', message: 'browser closed' };

describe('QA testing protocol', () => {
  it('normalizes plans, canonicalizes JSON, and binds task payloads to the plan digest', () => {
    const plan = structuredPlanSchema.parse(planInput);
    const planDigest = computeStructuredPlanDigest(planInput);
    expect(plan).toMatchObject({
      mode: 'act',
      execution: { timeoutSeconds: 1800, maxAttempts: 1, failFast: false, shards: 1 },
      cases: [{ id: 'case-1', tags: [] }]
    });
    expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
    expect(verifyStructuredPlanDigest(plan, planDigest)).toBe(true);
    expect(verifyStructuredPlanDigest({ ...plan, name: 'changed' }, planDigest)).toBe(false);

    expect(testingTaskPayloadSchema.parse({
      ...taskContext,
      planDigest,
      plan,
      shard: { index: 0, total: 1 },
      selectedCaseIds: ['case-1']
    }).selectedCaseIds).toEqual(['case-1']);

    expect(() => testingTaskPayloadSchema.parse({
      ...taskContext,
      planDigest: artifactDigest,
      plan,
      shard: { index: 0, total: 1 },
      selectedCaseIds: ['case-1']
    })).toThrow('plan digest does not match');
  });

  it('rejects contradictory sharding, attempts, missing cases, and duplicate identifiers', () => {
    expect(() => structuredPlanSchema.parse({
      ...planInput,
      cases: [planInput.cases[0], { ...planInput.cases[0] }]
    })).toThrow('identifier must be unique');
    expect(() => structuredPlanSchema.parse({
      ...planInput,
      execution: { shards: 2 }
    })).toThrow('shard count cannot exceed case count');

    const retryPlan = structuredPlanSchema.parse({
      ...planInput,
      execution: { maxAttempts: 1, shards: 1 }
    });
    const planDigest = computeStructuredPlanDigest(retryPlan);
    expect(() => testingTaskPayloadSchema.parse({
      ...taskContext,
      attempt: 2,
      planDigest,
      plan: retryPlan,
      shard: { index: 0, total: 2 },
      selectedCaseIds: ['case-1', 'case-1', 'missing-case']
    })).toThrow();
  });

  it('accepts JSON-only package extension data and distinguishes raw input from normalized output', () => {
    const rawAction: TypedTestingActionInput = {
      id: 'action-1',
      caseId: 'case-1',
      stepId: 'step-1',
      action: { type: 'navigate', url: 'https://example.com' }
    };
    expect(typedTestingActionSchema.parse(rawAction)).toMatchObject({ assertions: [] });
    expect(() => jsonValueSchema.parse(BigInt(1))).toThrow();
    expect(() => jsonValueSchema.parse({ callback: () => undefined })).toThrow();
    expect(() => typedTestingActionSchema.parse({
      ...rawAction,
      assertions: [
        { id: 'same', subject: 'page.title', operator: 'equals' },
        { id: 'same', subject: 'page.url', operator: 'equals' }
      ]
    })).toThrow('identifier must be unique');
  });

  it('enforces assertion, case, evidence, cleanup, and final-result invariants', () => {
    expect(() => assertionResultSchema.parse({
      assertionId: 'assertion-1', conclusion: 'error'
    })).toThrow();
    expect(() => caseResultSchema.parse({
      ...casePassed,
      conclusion: 'failed'
    })).toThrow('failed case requires a failed assertion');
    expect(() => caseResultSchema.parse({
      ...casePassed,
      assertions: [{ ...assertionPassed, conclusion: 'failed' }]
    })).toThrow('passed case cannot contain failed assertions');

    expect(() => evidenceDescriptorSchema.parse({
      id: 'evidence-1', runId: 'run-1', testingTaskId: 'testing-task-1', attempt: 1,
      kind: 'screenshot', state: 'available', contentType: 'image/png', size: 10,
      digest: artifactDigest, createdAt: startedAt
    })).toThrow();
    expect(() => evidenceDescriptorSchema.parse({
      id: 'evidence-1', runId: 'run-1', testingTaskId: 'testing-task-1', attempt: 1,
      kind: 'screenshot', state: 'pending', contentType: 'image/png', size: 10,
      digest: artifactDigest, uri: 'https://example.com/evidence', createdAt: startedAt
    })).toThrow();
    expect(() => cleanupResultSchema.parse({
      conclusion: 'failed', startedAt, completedAt, errors: []
    })).toThrow();
    expect(() => cleanupResultSchema.parse({
      conclusion: 'succeeded', startedAt, completedAt, errors: [qaError]
    })).toThrow();

    expect(testingTaskResultSchema.parse({
      ...taskContext,
      conclusion: 'passed',
      startedAt,
      completedAt,
      caseResults: [casePassed],
      cleanup: { conclusion: 'succeeded', startedAt, completedAt }
    })).toMatchObject({ evidenceIds: [], cleanup: { errors: [] } });
    expect(() => testingTaskResultSchema.parse({
      ...taskContext,
      conclusion: 'passed',
      startedAt,
      completedAt,
      caseResults: [],
      cleanup: { conclusion: 'succeeded', startedAt, completedAt }
    })).toThrow();
    expect(() => testingTaskResultSchema.parse({
      ...taskContext,
      conclusion: 'error',
      startedAt,
      completedAt,
      caseResults: [],
      cleanup: { conclusion: 'succeeded', startedAt, completedAt }
    })).toThrow();
    expect(() => testingTaskResultSchema.parse({
      ...taskContext,
      conclusion: 'timed_out',
      startedAt,
      completedAt,
      caseResults: [],
      cleanup: { conclusion: 'succeeded', startedAt, completedAt }
    })).toThrow();
    expect(testingTaskResultSchema.parse({
      ...taskContext,
      conclusion: 'timed_out',
      startedAt,
      completedAt,
      caseResults: [],
      cleanup: { conclusion: 'succeeded', startedAt, completedAt },
      error: qaError
    })).toMatchObject({ conclusion: 'timed_out', error: { retryable: false } });
    expect(() => testingTaskResultSchema.parse({
      ...taskContext,
      conclusion: 'passed',
      startedAt,
      completedAt,
      caseResults: [{ ...casePassed, attempt: 2 }],
      cleanup: { conclusion: 'succeeded', startedAt, completedAt }
    })).toThrow('case result attempt must match task result');
  });

  it('validates lifecycle snapshots, legal transitions, typed events, and event ordering', () => {
    expect(isQaRunTransitionAllowed('queued', 'running')).toBe(true);
    expect(isQaRunTransitionAllowed('running', 'queued')).toBe(false);
    expect(isQaRunTransitionAllowed('completed', 'completed')).toBe(false);
    expect(() => qaRunSnapshotSchema.parse({
      id: 'run-1', userId: 'user-1', planId: 'plan-1', planDigest: artifactDigest,
      testingTaskIds: ['testing-task-1'], createdAt: startedAt, updatedAt: completedAt,
      status: 'completed', conclusion: 'error', completedAt
    })).toThrow();
    expect(() => qaRunSnapshotSchema.parse({
      id: 'run-1', userId: 'user-1', planId: 'plan-1', planDigest: artifactDigest,
      testingTaskIds: ['testing-task-1'], createdAt: startedAt, updatedAt: completedAt,
      status: 'completed', conclusion: 'passed', completedAt, error: qaError
    })).toThrow();
    expect(qaRunSnapshotSchema.parse({
      id: 'run-1', userId: 'user-1', planId: 'plan-1', planDigest: artifactDigest,
      testingTaskIds: ['testing-task-1'], createdAt: startedAt, updatedAt: completedAt,
      status: 'completed', conclusion: 'timed_out', completedAt, error: qaError
    })).toMatchObject({ conclusion: 'timed_out', error: { retryable: false } });

    const first = qaRunEventSchema.parse({
      id: 'event-1', runId: 'run-1', sequence: 1, type: 'run.queued', timestamp: startedAt,
      payload: { planId: 'plan-1', planDigest: artifactDigest }
    });
    const second = qaRunEventSchema.parse({
      id: 'event-2', runId: 'run-1', testingTaskId: 'testing-task-1', attempt: 1,
      sequence: 2, type: 'case.started', timestamp: completedAt, payload: { caseId: 'case-1' }
    });
    expect(qaRunEventBatchSchema.parse([first, second])).toHaveLength(2);
    expect(() => qaRunEventBatchSchema.parse([second, first])).toThrow('strictly increasing');
    expect(() => qaRunEventSchema.parse({
      id: 'event-3', runId: 'run-1', sequence: 3, type: 'task.claimed', timestamp: completedAt,
      payload: {}
    })).toThrow();
  });

  it('requires fencing context on worker event submissions', () => {
    expect(testingTaskEventSubmissionSchema.parse({
      ...taskContext,
      event: {
        id: 'worker-event-1',
        type: 'case.started',
        timestamp: startedAt,
        payload: { caseId: 'case-1' }
      }
    })).toMatchObject({ fencingToken: taskContext.fencingToken });
    expect(() => testingTaskEventSubmissionSchema.parse({
      runId: 'run-1', testingTaskId: 'testing-task-1', attempt: 1,
      event: { id: 'worker-event-1', type: 'cleanup.started', timestamp: startedAt, payload: {} }
    })).toThrow();
    expect(() => testingTaskEventSubmissionSchema.parse({
      ...taskContext,
      event: {
        id: 'worker-event-2',
        type: 'evidence.created',
        timestamp: startedAt,
        payload: {
          evidence: {
            id: 'evidence-1', runId: 'other-run', testingTaskId: 'other-task', attempt: 2,
            kind: 'screenshot', state: 'pending', contentType: 'image/png', size: 10,
            digest: artifactDigest, createdAt: startedAt
          }
        }
      }
    })).toThrow('evidence run must match submission context');
    expect(() => testingTaskEventSubmissionSchema.parse({
      ...taskContext,
      event: {
        id: 'worker-event-3', type: 'case.completed', timestamp: completedAt,
        payload: { result: { ...casePassed, attempt: 2 } }
      }
    })).toThrow('case result attempt must match submission context');
  });
});
