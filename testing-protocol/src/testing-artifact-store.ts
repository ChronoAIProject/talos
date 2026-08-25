import { z } from 'zod';
import {
  digestJson,
  identifierSchema,
  immutableReferenceSchema,
  sha256DigestSchema,
  testingAttemptBindingSchema
} from './contracts.js';

const timestampSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const talosReferenceSchema = z.string().min(1).max(2048)
  .regex(/^talos:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/);
const authorizationReferenceSchema = z.string().min(1).max(2048)
  .regex(/^authorization:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/);
const stableObjectKeySchema = z.string().min(1).max(1024)
  .regex(/^qa\/[A-Za-z0-9][A-Za-z0-9._%~-]*\/[A-Za-z0-9][A-Za-z0-9._%~-]*\/[A-Za-z0-9][A-Za-z0-9._%~-]*$/);

export const testingArtifactMediaTypeSchema = z.enum([
  'image/png',
  'application/vnd.fkst.testing.sanitized+json'
]);

export const testingArtifactAuthoritySchema = z.object({
  binding: testingAttemptBindingSchema,
  machine_id: identifierSchema,
  runtime_instance_id: identifierSchema,
  subject: identifierSchema,
  audience: z.literal('testing-artifact-store'),
  claim: z.object({
    schema: z.literal('talos.testing-lease-claim/v1'),
    ref: talosReferenceSchema,
    digest: sha256DigestSchema,
    expires_at: timestampSchema
  }).strict()
}).strict().superRefine((value, context) => {
  if (!value.claim.ref.startsWith(`talos://testing/claims/${value.binding.run_id}/`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'artifact claim reference must match the bound run',
      path: ['claim', 'ref']
    });
  }
});

export const testingArtifactDescriptorSchema = z.object({
  evidence_id: identifierSchema,
  role: z.enum(['evidence_png', 'sanitized_json']),
  media_type: testingArtifactMediaTypeSchema,
  size: z.number().int().positive().max(5_242_880),
  digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  if (value.role === 'evidence_png' && value.media_type !== 'image/png') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'PNG evidence role requires image/png', path: ['media_type'] });
  }
  if (value.role === 'sanitized_json') {
    if (value.media_type !== 'application/vnd.fkst.testing.sanitized+json') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'sanitized JSON role requires its bounded media type', path: ['media_type'] });
    }
    if (value.size > 1_048_576) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'sanitized JSON exceeds the one MiB limit', path: ['size'] });
    }
  }
});

export const computeTestingArtifactStableObjectKey = (
  authorityInput: unknown,
  artifactInput: unknown
): string => {
  const authority = testingArtifactAuthoritySchema.parse(authorityInput);
  const artifact = testingArtifactDescriptorSchema.parse(artifactInput);
  return stableObjectKeySchema.parse([
    'qa',
    encodeURIComponent(authority.binding.run_id),
    encodeURIComponent(authority.binding.attempt_id),
    encodeURIComponent(artifact.evidence_id)
  ].join('/'));
};

const artifactOperationCoreSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  authority: testingArtifactAuthoritySchema,
  artifact: testingArtifactDescriptorSchema
}).strict();

export const testingArtifactPrepareRequestCoreSchema = artifactOperationCoreSchema.extend({
  schema_version: z.literal('talos.testing-artifact-prepare-request/v1')
}).strict();

export const computeTestingArtifactPrepareRequestDigest = (input: unknown): string =>
  digestJson(testingArtifactPrepareRequestCoreSchema.parse(input));

export const testingArtifactPrepareRequestSchema = testingArtifactPrepareRequestCoreSchema.extend({
  request_digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  const { request_digest: requestDigest, ...core } = value;
  if (digestJson(core) !== requestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'prepare request digest mismatch', path: ['request_digest'] });
  }
});

export const testingArtifactUploadGrantSchema = z.object({
  schema_version: z.literal('talos.testing-artifact-upload-grant/v1'),
  grant_ref: authorizationReferenceSchema,
  grant_digest: sha256DigestSchema,
  stable_object_key: stableObjectKeySchema,
  prepare_request_digest: sha256DigestSchema,
  idempotency_key: idempotencyKeySchema,
  authority: testingArtifactAuthoritySchema,
  artifact: testingArtifactDescriptorSchema,
  allowed_method: z.literal('PUT'),
  allowed_path: z.string().min(1).max(2048).regex(/^\/v1\/testing\/artifacts\/[A-Za-z0-9._~%-]+:upload$/),
  nonce: identifierSchema,
  not_before: timestampSchema,
  expires_at: timestampSchema
}).strict().refine((value) => Date.parse(value.not_before) < Date.parse(value.expires_at), {
  message: 'upload grant expiry must follow not-before',
  path: ['expires_at']
});

export const testingArtifactPrepareResponseSchema = z.object({
  schema_version: z.literal('talos.testing-artifact-prepare-response/v1'),
  stable_object_key: stableObjectKeySchema,
  upload_grant: testingArtifactUploadGrantSchema
}).strict().refine((value) => value.stable_object_key === value.upload_grant.stable_object_key, {
  message: 'prepare response object key must match its grant',
  path: ['upload_grant', 'stable_object_key']
});

export const testingArtifactCommitRequestCoreSchema = artifactOperationCoreSchema.extend({
  schema_version: z.literal('talos.testing-artifact-commit-request/v1'),
  stable_object_key: stableObjectKeySchema,
  prepare_request_digest: sha256DigestSchema,
  provider_object_version: identifierSchema
}).strict();

export const computeTestingArtifactCommitRequestDigest = (input: unknown): string =>
  digestJson(testingArtifactCommitRequestCoreSchema.parse(input));

export const testingArtifactCommitRequestSchema = testingArtifactCommitRequestCoreSchema.extend({
  request_digest: sha256DigestSchema
}).strict().superRefine((value, context) => {
  const { request_digest: requestDigest, ...core } = value;
  if (digestJson(core) !== requestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'commit request digest mismatch', path: ['request_digest'] });
  }
});

export const testingArtifactIngestReceiptSchema = z.object({
  schema_version: z.literal('talos.testing-artifact-ingest-receipt/v1'),
  receipt_ref: z.string().min(1).max(2048)
    .regex(/^artifact:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/),
  receipt_digest: sha256DigestSchema,
  stable_object_key: stableObjectKeySchema,
  commit_request_digest: sha256DigestSchema,
  idempotency_key: idempotencyKeySchema,
  authority: testingArtifactAuthoritySchema,
  artifact: testingArtifactDescriptorSchema,
  provider_object_version: identifierSchema,
  committed_at: timestampSchema
}).strict();

export const testingArtifactCommitResponseSchema = z.object({
  schema_version: z.literal('talos.testing-artifact-commit-response/v1'),
  artifact: immutableReferenceSchema.extend({ schema: z.literal('testing-evidence-object/v1') }).strict(),
  ingest_receipt: testingArtifactIngestReceiptSchema
}).strict();

export const testingArtifactLookupRequestSchema = z.object({
  schema_version: z.literal('talos.testing-artifact-lookup-request/v1'),
  stable_object_key: stableObjectKeySchema,
  idempotency_key: idempotencyKeySchema,
  authority: testingArtifactAuthoritySchema,
  artifact: testingArtifactDescriptorSchema
}).strict();

export const testingArtifactLookupResponseSchema = z.discriminatedUnion('disposition', [
  z.object({
    schema_version: z.literal('talos.testing-artifact-lookup-response/v1'),
    disposition: z.literal('not_found'),
    stable_object_key: stableObjectKeySchema
  }).strict(),
  z.object({
    schema_version: z.literal('talos.testing-artifact-lookup-response/v1'),
    disposition: z.literal('found'),
    stable_object_key: stableObjectKeySchema,
    artifact: immutableReferenceSchema.extend({ schema: z.literal('testing-evidence-object/v1') }).strict(),
    ingest_receipt: testingArtifactIngestReceiptSchema
  }).strict()
]);

export type TestingArtifactAuthority = z.infer<typeof testingArtifactAuthoritySchema>;
export type TestingArtifactDescriptor = z.infer<typeof testingArtifactDescriptorSchema>;
export type TestingArtifactPrepareRequest = z.infer<typeof testingArtifactPrepareRequestSchema>;
export type TestingArtifactPrepareResponse = z.infer<typeof testingArtifactPrepareResponseSchema>;
export type TestingArtifactCommitRequest = z.infer<typeof testingArtifactCommitRequestSchema>;
export type TestingArtifactCommitResponse = z.infer<typeof testingArtifactCommitResponseSchema>;
export type TestingArtifactLookupRequest = z.infer<typeof testingArtifactLookupRequestSchema>;
export type TestingArtifactLookupResponse = z.infer<typeof testingArtifactLookupResponseSchema>;
