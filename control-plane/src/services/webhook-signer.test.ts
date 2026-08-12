import { describe, expect, it } from 'vitest';
import { WebhookSigner } from './webhook-signer.js';

describe('WebhookSigner', () => {
  it('signs and rejects replayed or modified events', () => {
    const signer = new WebhookSigner('webhook-secret-1234', 300);
    const event = { id: 'evt_1', type: 'task.completed' as const, taskId: 'task_1', userId: 'user_1', timestamp: new Date(1000000).toISOString(), payload: { status: 'completed' } };
    const signed = signer.sign(event, 1000000);
    expect(signer.verify(signed, 1000000)).toBe(true);
    expect(signer.verify({ ...signed, body: signed.body.replace('completed', 'failed') }, 1000000)).toBe(false);
    expect(signer.verify(signed, 1000000 + 301000)).toBe(false);
  });
});
