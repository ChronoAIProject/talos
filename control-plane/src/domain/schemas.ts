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
  pool_id: z.string().trim().min(1).max(255).optional(),
  constraints: z
    .object({
      budget: z.number().finite().nonnegative().optional(),
      deadline: z.string().datetime({ offset: true }).optional(),
      requirements: requirementsSchema.optional()
    })
    .default({}),
  mode: z.enum(['read_only', 'act']).default('read_only'),
  callback: z.string().url().max(2048).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'callback must use http or https').optional()
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

export const adminPoolSchema = z.object({
  id: z.string().min(1),
  visibility: z.enum(['private', 'org', 'platform']),
  owner_user_id: z.string().min(1).optional(),
  tags: z.record(z.union([z.string(), z.boolean()])).default({})
});

export const adminMachineSchema = z.object({
  id: z.string().min(1),
  pool_id: z.string().min(1),
  tags: z.record(z.union([z.string(), z.boolean()])).default({}),
  capacity: z.number().int().positive().default(1),
  online: z.boolean().default(true),
  worker_token: z.string().min(16).optional()
});

export const adminRotateMachineSchema = z.object({ worker_token: z.string().min(16).optional() });

export const adminProfileSchema = z.object({ id: z.string().min(1), user_id: z.string().min(1), machine_id: z.string().min(1).optional() });

export const selfPoolSchema = z.object({
  id: z.string().trim().min(1).max(255).optional(),
  visibility: z.enum(['private', 'org', 'platform']).optional(),
  owner_user_id: z.string().trim().min(1).max(255).optional(),
  tags: z.record(z.union([z.string(), z.boolean()])).default({})
});

export const selfMachineSchema = z.object({
  id: z.string().trim().min(1).max(255),
  tags: z.record(z.union([z.string(), z.boolean()])).default({}),
  capacity: z.number().int().positive().default(1),
  online: z.boolean().default(true),
  worker_token: z.string().min(16).optional()
});

export const selfRotateMachineSchema = z.object({ worker_token: z.string().min(16).optional() });

export const selfProfileSchema = z.object({
  id: z.string().trim().min(1).max(255).optional(),
  machine_id: z.string().trim().min(1).max(255).optional()
});

export type TaskCreateRequest = z.infer<typeof taskCreateSchema>;
export type TaskInputRequest = z.infer<typeof taskInputSchema>;
