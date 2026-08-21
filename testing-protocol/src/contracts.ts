import { createHash } from 'node:crypto';
import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const jsonStringSchema = z.string().refine(isWellFormedUnicode, 'JSON strings must contain valid Unicode');

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  jsonStringSchema,
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonStringSchema, jsonValueSchema)
]));

export const identifierSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const artifactReferenceValueSchema = z.string().min(1).max(2048)
  .regex(/^artifact:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/)
  .refine((value) => !value.split('/').includes('..'), 'artifact ref cannot contain dot segments');
export const exactSourceRevisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const exactPackageVersionSchema = z.string().min(1).max(128)
  .regex(/^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

const serializeCanonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${serializeCanonicalJson(value[key] as JsonValue)}`).join(',')}}`;
};

export const canonicalJson = (input: unknown): string => serializeCanonicalJson(jsonValueSchema.parse(input));

export const digestJson = (input: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`;

export const verifyJsonDigest = (value: unknown, digest: string): boolean => {
  if (!sha256DigestSchema.safeParse(digest).success || !jsonValueSchema.safeParse(value).success) return false;
  return digestJson(value) === digest;
};

export const digestEnvelopeSchema = z.object({
  schema_version: z.literal('talos.canonical-json-envelope/v1'),
  value: jsonValueSchema,
  canonical_digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  if (!verifyJsonDigest(value.value, value.canonical_digest)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'canonical_digest does not match value',
      path: ['canonical_digest']
    });
  }
});

export const artifactPointerSchema = z.object({
  ref: artifactReferenceValueSchema,
  digest: sha256DigestSchema
}).strict();

export const immutableReferenceSchema = artifactPointerSchema.extend({
  schema: identifierSchema
}).strict();

export const sourceRevisionReferenceSchema = z.object({
  repository_id: identifierSchema,
  exact_revision: exactSourceRevisionSchema,
  ref: artifactReferenceValueSchema,
  digest: sha256DigestSchema
}).strict();

export const testingPackageReferenceSchema = z.object({
  package_id: identifierSchema,
  version: exactPackageVersionSchema,
  digest: sha256DigestSchema
}).strict();

const projectPackSnapshotReferenceSchema = immutableReferenceSchema.extend({
  schema: z.literal('pql.project-pack-snapshot/v1')
}).strict();
const testSelectionReferenceSchema = immutableReferenceSchema.extend({
  schema: z.literal('pql.test-selection/v1')
}).strict();
const testingDesignInputSetReferenceSchema = immutableReferenceSchema.extend({
  schema: z.literal('pql.testing-design-input-set.v1')
}).strict();
const structuredPlanReferenceSchema = immutableReferenceSchema.extend({
  schema: z.literal('testing-structured-plan.v2')
}).strict();

export const testingInputReferencesSchema = z.object({
  schema_version: z.literal('talos.testing-input-references/v1'),
  project_pack_snapshot: projectPackSnapshotReferenceSchema,
  test_selection: testSelectionReferenceSchema,
  testing_design_input_set: testingDesignInputSetReferenceSchema,
  source_revision: sourceRevisionReferenceSchema,
  structured_plan: structuredPlanReferenceSchema,
  environment_profile: artifactPointerSchema,
  testing_package: testingPackageReferenceSchema
}).strict();

export const testingAttemptBindingSchema = z.object({
  run_id: identifierSchema,
  task_id: identifierSchema,
  attempt_id: identifierSchema,
  generation: z.number().int().positive(),
  fence_token: z.string().min(16).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
}).strict();

const attemptBoundReferenceSchema = immutableReferenceSchema.extend({
  binding: testingAttemptBindingSchema
}).strict();

const caseResultSetReferenceSchema = attemptBoundReferenceSchema.extend({
  schema: z.literal('testing-case-result-set.v2')
}).strict();
const evidenceManifestReferenceSchema = attemptBoundReferenceSchema.extend({
  schema: z.literal('testing-evidence-manifest.v1')
}).strict();
const cleanupReceiptReferenceSchema = attemptBoundReferenceSchema.extend({
  schema: z.literal('qa.local-cleanup-receipt/v2')
}).strict();

export const terminalReferenceProjectionSchema = z.object({
  schema_version: z.literal('talos.testing-terminal-refs/v1'),
  binding: testingAttemptBindingSchema,
  case_result_set: caseResultSetReferenceSchema.optional(),
  evidence_manifest: evidenceManifestReferenceSchema.optional(),
  cleanup_receipt: cleanupReceiptReferenceSchema.optional()
}).strict().superRefine((value, context) => {
  const expected = JSON.stringify(value.binding);
  const fields = ['case_result_set', 'evidence_manifest', 'cleanup_receipt'] as const;
  for (const field of fields) {
    const reference = value[field];
    if (reference !== undefined && JSON.stringify(reference.binding) !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} binding must match terminal binding`,
        path: [field, 'binding']
      });
    }
  }
});

export type ImmutableReference = z.infer<typeof immutableReferenceSchema>;
export type SourceRevisionReference = z.infer<typeof sourceRevisionReferenceSchema>;
export type TestingPackageReference = z.infer<typeof testingPackageReferenceSchema>;
export type TestingInputReferences = z.infer<typeof testingInputReferencesSchema>;
export type TestingAttemptBinding = z.infer<typeof testingAttemptBindingSchema>;
export type TerminalReferenceProjection = z.infer<typeof terminalReferenceProjectionSchema>;
