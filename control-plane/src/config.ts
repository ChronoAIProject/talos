import { createHash } from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({
  TALOS_WEBHOOK_SECRET: z.string().min(16),
  TALOS_PORT: z.coerce.number().int().positive().default(8080),
  TALOS_ADMIN_TOKEN: z.string().min(16),
  TALOS_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  TALOS_DATABASE_URL: z.string().url().refine((value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'), 'TALOS_DATABASE_URL must use mongodb or mongodb+srv').optional(),
  TALOS_DATABASE_NAME: z.string().trim().min(1).default('talos')
});

export interface TalosConfig { webhookSecret: string; port: number; adminToken: string; sweepIntervalMs: number; databaseUrl?: string; databaseName: string; }

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): TalosConfig => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid Talos configuration: ${parsed.error.message}`);
  return { webhookSecret: parsed.data.TALOS_WEBHOOK_SECRET, port: parsed.data.TALOS_PORT, adminToken: parsed.data.TALOS_ADMIN_TOKEN, sweepIntervalMs: parsed.data.TALOS_SWEEP_INTERVAL_MS, databaseName: parsed.data.TALOS_DATABASE_NAME, ...(parsed.data.TALOS_DATABASE_URL === undefined ? {} : { databaseUrl: parsed.data.TALOS_DATABASE_URL }) };
};

export const hashWorkerToken = (token: string): string => createHash('sha256').update(token).digest('hex');
