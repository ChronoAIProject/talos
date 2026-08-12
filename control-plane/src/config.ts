import { createHash } from 'node:crypto';
import { z } from 'zod';

const configSchema = z.object({
  TALOS_WEBHOOK_SECRET: z.string().min(16),
  TALOS_PORT: z.coerce.number().int().positive().default(8080),
  TALOS_ADMIN_TOKEN: z.string().min(16),
  TALOS_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  TALOS_DATABASE_URL: z.string().url().refine((value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'), 'TALOS_DATABASE_URL must use mongodb or mongodb+srv').optional(),
  TALOS_DATABASE_NAME: z.string().trim().min(1).default('talos'),
  TALOS_NYXID_JWT_PUBLIC_KEY: z.string().min(1).optional(),
  TALOS_NYXID_JWKS_URL: z.string().url().optional(),
  TALOS_NYXID_ISSUER: z.string().min(1).optional(),
  TALOS_NYXID_AUDIENCE: z.string().min(1).optional()
}).superRefine((value, context) => {
  const sourceConfigured = value.TALOS_NYXID_JWT_PUBLIC_KEY !== undefined || value.TALOS_NYXID_JWKS_URL !== undefined;
  if (sourceConfigured && value.TALOS_NYXID_ISSUER === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['TALOS_NYXID_ISSUER'], message: 'required when NyxID JWT verification is configured' });
  if (sourceConfigured && value.TALOS_NYXID_AUDIENCE === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['TALOS_NYXID_AUDIENCE'], message: 'required when NyxID JWT verification is configured' });
  if (value.TALOS_NYXID_JWT_PUBLIC_KEY !== undefined && value.TALOS_NYXID_JWKS_URL !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['TALOS_NYXID_JWKS_URL'], message: 'configure either public key or JWKS URL, not both' });
});

export interface TalosConfig {
  webhookSecret: string;
  port: number;
  adminToken: string;
  sweepIntervalMs: number;
  databaseUrl?: string;
  databaseName: string;
  nyxidJwtPublicKey?: string;
  nyxidJwksUrl?: string;
  nyxidIssuer?: string;
  nyxidAudience?: string;
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): TalosConfig => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid Talos configuration: ${parsed.error.message}`);
  return {
    webhookSecret: parsed.data.TALOS_WEBHOOK_SECRET,
    port: parsed.data.TALOS_PORT,
    adminToken: parsed.data.TALOS_ADMIN_TOKEN,
    sweepIntervalMs: parsed.data.TALOS_SWEEP_INTERVAL_MS,
    databaseName: parsed.data.TALOS_DATABASE_NAME,
    ...(parsed.data.TALOS_DATABASE_URL === undefined ? {} : { databaseUrl: parsed.data.TALOS_DATABASE_URL }),
    ...(parsed.data.TALOS_NYXID_JWT_PUBLIC_KEY === undefined ? {} : { nyxidJwtPublicKey: parsed.data.TALOS_NYXID_JWT_PUBLIC_KEY }),
    ...(parsed.data.TALOS_NYXID_JWKS_URL === undefined ? {} : { nyxidJwksUrl: parsed.data.TALOS_NYXID_JWKS_URL }),
    ...(parsed.data.TALOS_NYXID_ISSUER === undefined ? {} : { nyxidIssuer: parsed.data.TALOS_NYXID_ISSUER }),
    ...(parsed.data.TALOS_NYXID_AUDIENCE === undefined ? {} : { nyxidAudience: parsed.data.TALOS_NYXID_AUDIENCE })
  };
};

export const hashWorkerToken = (token: string): string => createHash('sha256').update(token).digest('hex');
