import { z } from 'zod';

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('screenshot') }),
  z.object({ type: z.literal('click'), x: z.number().finite(), y: z.number().finite(), button: z.enum(['left', 'middle', 'right']).default('left') }),
  z.object({ type: z.literal('type'), text: z.string().max(10000) }),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(100) }),
  z.object({ type: z.literal('scroll'), deltaX: z.number().finite().default(0), deltaY: z.number().finite() }),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().nonnegative().max(60000) }),
  z.object({ type: z.literal('act-on-a11y-node'), nodeId: z.string().min(1), action: z.enum(['click', 'type']), text: z.string().optional() }),
  z.object({ type: z.literal('extract-structured-dom'), selector: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('navigate'), url: z.string().url() })
]);

export type Action = z.infer<typeof actionSchema>;

export interface Screenshot { mimeType: 'image/png'; data: string; width: number; height: number; }
export interface ActionResult { screenshot?: Screenshot; value?: unknown; }
