import { createHash } from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({
  TALOS_WEBHOOK_SECRET: z.string().min(16),
  TALOS_PORT: z.coerce.number().int().positive().default(8080)
});

export interface TalosConfig { webhookSecret: string; port: number; }

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): TalosConfig => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid Talos configuration: ${parsed.error.message}`);
  return { webhookSecret: parsed.data.TALOS_WEBHOOK_SECRET, port: parsed.data.TALOS_PORT };
};

export const hashWorkerToken = (token: string): string => createHash('sha256').update(token).digest('hex');
