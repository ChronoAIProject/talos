import { browserActionSchema, type BrowserActionInput } from '@talos/testing-protocol';

export const actionSchema = browserActionSchema;

export type Action = BrowserActionInput;

export interface Screenshot { mimeType: 'image/jpeg' | 'image/png'; data: string; width: number; height: number; }
export interface ActionResult {
  screenshot?: Screenshot;
  value?: unknown;
  error?: { code: string; message: string };
}
