import { z } from 'zod';

export const capabilityTagSchema = z.enum([
  'os',
  'region',
  'residential_ip',
  'headed_display',
  'browser',
  'computer_use'
]);

const requirementsSchema = z.record(
  capabilityTagSchema,
  z.union([z.string().min(1), z.boolean()])
);

export const taskCreateSchema = z.object({
  kind: z.enum(['browse', 'computer_use']),
  goal: z.string().trim().min(1).max(10000),
  site_hint: z.string().trim().min(1).max(255).optional(),
  profile_id: z.string().trim().min(1).max(255).optional(),
  constraints: z
    .object({
      budget: z.number().finite().nonnegative().optional(),
      deadline: z.string().datetime({ offset: true }).optional(),
      requirements: requirementsSchema.optional()
    })
    .default({}),
  mode: z.enum(['read_only', 'act']).default('read_only'),
  callback: z.string().url().max(2048).optional()
});

export const taskInputSchema = z.object({
  kind: z.enum(['choice', 'text', 'otp']),
  value: z.string().min(1).max(10000)
});

export const handoffRequestSchema = z.object({
  expires_in_seconds: z.number().int().positive().max(3600).default(900)
});

export const workerClaimSchema = z.object({
  worker_id: z.string().trim().min(1).max(255),
  machine_id: z.string().trim().min(1).max(255)
});

export const heartbeatSchema = z.object({
  lease_token: z.string().min(1),
  extend_seconds: z.number().int().positive().max(300).default(60)
});

export const resultSchema = z.object({
  lease_token: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  findings: z
    .array(
      z.object({
        key: z.string().min(1).max(255),
        value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])
      })
    )
    .default([]),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional()
});

export const artifactSchema = z.object({
  lease_token: z.string().min(1),
  name: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  uri: z.string().url().max(2048)
});

export type TaskCreateRequest = z.infer<typeof taskCreateSchema>;
export type TaskInputRequest = z.infer<typeof taskInputSchema>;
