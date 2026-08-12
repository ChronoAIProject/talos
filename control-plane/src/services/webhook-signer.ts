import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookEvent } from '../domain/types.js';

export interface SignedWebhook {
  id: string;
  timestamp: string;
  signature: string;
  body: string;
}

export class WebhookSigner {
  public constructor(private readonly secret: string, private readonly toleranceSeconds = 300) {}

  public sign(event: WebhookEvent, now = Date.now()): SignedWebhook {
    const timestamp = Math.floor(now / 1000).toString();
    const body = JSON.stringify(event);
    const signature = this.digest(timestamp, body);
    return { id: event.id, timestamp, signature, body };
  }

  public verify(signed: SignedWebhook, now = Date.now()): boolean {
    const timestamp = Number(signed.timestamp);
    if (!Number.isFinite(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > this.toleranceSeconds) return false;
    const expected = this.digest(signed.timestamp, signed.body);
    const actual = Buffer.from(signed.signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  }

  private digest(timestamp: string, body: string): string {
    return createHmac('sha256', this.secret).update(`${timestamp}.${body}`).digest('hex');
  }
}
