import type { Repository } from '../storage/repository.js';
import type { WebhookEvent } from '../domain/types.js';
import { TalosError } from '../domain/errors.js';
import type { WebhookSigner } from './webhook-signer.js';

export interface WebhookPolicy {
  schemes?: readonly string[];
  hosts?: readonly string[];
}

export interface WebhookDispatcherOptions {
  fetchImpl?: typeof fetch;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  policy?: WebhookPolicy;
  clock?: () => number;
}

export class WebhookDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly policy: Required<WebhookPolicy>;
  private readonly clock: () => number;

  public constructor(
    private readonly repository: Repository,
    private readonly signer: WebhookSigner,
    options: WebhookDispatcherOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = options.retries ?? 3;
    this.backoffMs = options.backoffMs ?? 50;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.policy = {
      schemes: options.policy?.schemes ?? ['http:', 'https:'],
      hosts: options.policy?.hosts ?? []
    };
    this.clock = options.clock ?? Date.now;
  }

  public validateCallback(callback: string): void {
    const url = new URL(callback);
    if (!this.policy.schemes.includes(url.protocol)) throw new TalosError('validation_error', 'callback scheme is not allowed', 400);
    if (this.policy.hosts.length > 0 && !this.policy.hosts.includes(url.host)) throw new TalosError('validation_error', 'callback host is not allowed', 400);
  }

  public async dispatch(event: WebhookEvent, callback?: string, signed = this.signer.sign(event, this.clock())): Promise<void> {
    if (callback === undefined) {
      await this.update(event, { status: 'delivered', attempts: 0 });
      return;
    }
    this.validateCallback(callback);
    let lastError = 'delivery failed';
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(callback, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Talos-Webhook-Timestamp': signed.timestamp,
            'X-Talos-Webhook-Signature': signed.signature
          },
          body: signed.body,
          signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await this.update(event, { status: 'delivered', attempts: attempt, lastAttemptAt: new Date(this.clock()).toISOString() });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
        await this.update(event, { status: 'pending', attempts: attempt, lastAttemptAt: new Date(this.clock()).toISOString(), lastError });
        if (attempt < this.retries) await new Promise((resolve) => setTimeout(resolve, this.backoffMs * attempt));
      }
    }
    await this.update(event, { status: 'failed', attempts: this.retries, lastAttemptAt: new Date(this.clock()).toISOString(), lastError });
  }

  private async update(event: WebhookEvent, delivery: WebhookEvent['delivery']): Promise<void> {
    await this.repository.saveWebhook({ ...event, delivery });
  }
}
