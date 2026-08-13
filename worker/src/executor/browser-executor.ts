import type { Action, ActionResult } from '../protocol/actions.js';
import type { Executor, ExecutorContext } from './executor.js';

interface BrowserPage {
  screenshot(options: { type: 'jpeg'; quality: number } | { type: 'png' }): Promise<Buffer>;
  mouse: { click(x: number, y: number, options?: { button: 'left' | 'middle' | 'right' }): Promise<void>; wheel(x: number, y: number): Promise<void>; };
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void>; };
  waitForTimeout(milliseconds: number): Promise<void>;
  goto(url: string): Promise<unknown>;
  locator(selector: string): { allTextContents(): Promise<string[]>; click(): Promise<void>; fill(text: string): Promise<void>; };
  viewportSize(): { width: number; height: number } | null;
}

interface BrowserContext { close(): Promise<void>; newPage(): Promise<BrowserPage>; }
interface CdpBrowser { close(): Promise<void>; contexts(): BrowserContext[]; }
interface BrowserProvider { launchPersistentContext(path: string, options: Record<string, unknown>): Promise<BrowserContext>; connectOverCDP?(endpoint: string): Promise<CdpBrowser>; }

export interface BrowserExecutorOptions { profilePath: string; cdpEndpoint?: string; provider?: BrowserProvider; }

export class BrowserExecutor implements Executor {
  private context?: BrowserContext;
  private browser?: CdpBrowser;
  private page?: BrowserPage;
  public constructor(private readonly options: BrowserExecutorOptions) {}

  public async execute(action: Action, context: ExecutorContext): Promise<ActionResult> {
    if (context.masking) return {};
    const page = await this.getPage();
    switch (action.type) {
      case 'screenshot': {
        const viewport = page.viewportSize() ?? { width: 0, height: 0 };
        const format = action.format ?? 'jpeg';
        const options = format === 'jpeg'
          ? { type: 'jpeg' as const, quality: action.quality ?? 70 }
          : { type: 'png' as const };
        return {
          screenshot: {
            mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
            data: (await page.screenshot(options)).toString('base64'),
            ...viewport
          }
        };
      }
      case 'click': await page.mouse.click(action.x, action.y, { button: action.button }); return {};
      case 'type': await page.keyboard.type(action.text); return {};
      case 'key': await page.keyboard.press(action.key); return {};
      case 'scroll': await page.mouse.wheel(action.deltaX, action.deltaY); return {};
      case 'wait': await page.waitForTimeout(action.milliseconds); return {};
      case 'navigate': await page.goto(action.url); return {};
      case 'extract-structured-dom': return { value: await page.locator(action.selector).allTextContents() };
      case 'act-on-a11y-node': {
        const locator = page.locator(`[data-talos-a11y-id="${action.nodeId.replaceAll('"', '')}"]`);
        if (action.action === 'click') await locator.click(); else await locator.fill(action.text ?? '');
        return {};
      }
    }
  }

  public async close(): Promise<void> {
    if (this.browser !== undefined) await this.browser.close();
    else await this.context?.close();
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }

  private async getPage(): Promise<BrowserPage> {
    if (this.page !== undefined) return this.page;
    const provider = this.options.provider ?? await this.loadProvider();
    if (this.options.cdpEndpoint !== undefined && provider.connectOverCDP !== undefined) {
      this.browser = await provider.connectOverCDP(this.options.cdpEndpoint);
      this.context = this.browser.contexts()[0] ?? await provider.launchPersistentContext(this.options.profilePath, { headless: false });
    } else {
      this.context = await provider.launchPersistentContext(this.options.profilePath, { headless: false });
    }
    this.page = await this.context.newPage();
    return this.page;
  }

  private async loadProvider(): Promise<BrowserProvider> {
    const playwright = await import('playwright').catch(() => { throw new Error('Playwright is required to run BrowserExecutor'); });
    return playwright.chromium as unknown as BrowserProvider;
  }
}
