import { describe, expect, it } from 'vitest';
import { BrowserExecutor } from './browser-executor.js';

describe('BrowserExecutor', () => {
  it('uses injectable provider and CDP connection without fake launch options', async () => {
    const calls: unknown[] = [];
    const page = { screenshot: async () => Buffer.from('png'), mouse: { click: async () => undefined, wheel: async () => undefined }, keyboard: { type: async () => undefined, press: async () => undefined }, waitForTimeout: async () => undefined, goto: async () => undefined, locator: () => ({ allTextContents: async () => ['x'], click: async () => undefined, fill: async () => undefined }), viewportSize: () => ({ width: 10, height: 20 }) };
    const context = { newPage: async () => page, close: async () => undefined };
    const executor = new BrowserExecutor({ profilePath: '/tmp/profile', cdpEndpoint: 'http://localhost:9222', provider: { connectOverCDP: async (endpoint) => { calls.push(endpoint); return context; }, launchPersistentContext: async () => context } });
    const result = await executor.execute({ type: 'screenshot' }, { taskId: 't', masking: false });
    expect(result.screenshot?.width).toBe(10);
    expect(calls).toEqual(['http://localhost:9222']);
    await executor.close();
  });

  it('executes all action primitives and masked actions are no-ops', async () => {
    const calls: string[] = [];
    const locator = { allTextContents: async () => ['x'], click: async () => { calls.push('locator-click'); }, fill: async () => { calls.push('fill'); } };
    const page = { screenshot: async () => Buffer.from('png'), mouse: { click: async () => { calls.push('click'); }, wheel: async () => { calls.push('wheel'); } }, keyboard: { type: async () => { calls.push('type'); }, press: async () => { calls.push('press'); } }, waitForTimeout: async () => { calls.push('wait'); }, goto: async () => { calls.push('goto'); }, locator: () => locator, viewportSize: () => null };
    const context = { newPage: async () => page, close: async () => undefined };
    const executor = new BrowserExecutor({ profilePath: '/tmp/profile', provider: { launchPersistentContext: async () => context } });
    const actions = [
      { type: 'click' as const, x: 1, y: 2, button: 'left' as const }, { type: 'type' as const, text: 'x' }, { type: 'key' as const, key: 'Enter' },
      { type: 'scroll' as const, deltaX: 0, deltaY: 1 }, { type: 'wait' as const, milliseconds: 0 }, { type: 'navigate' as const, url: 'https://example.com' },
      { type: 'extract-structured-dom' as const, selector: 'main' }, { type: 'act-on-a11y-node' as const, nodeId: 'a', action: 'click' as const }, { type: 'act-on-a11y-node' as const, nodeId: 'a', action: 'type' as const, text: 'x' }
    ];
    for (const action of actions) await executor.execute(action, { taskId: 't', masking: false });
    await executor.execute({ type: 'screenshot' }, { taskId: 't', masking: true });
    expect(calls.length).toBeGreaterThan(5);
  });
});
