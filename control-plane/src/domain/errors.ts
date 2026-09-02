export class TalosError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(code: string, message: string, status = 400, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'TalosError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const TESTING_PUBLIC_ERROR_CATALOG = {
  validation_error: { classification: 'invalid_request', retryable: false },
  invalid_json: { classification: 'invalid_request', retryable: false },
  payload_too_large: { classification: 'invalid_request', retryable: false },
  unauthorized: { classification: 'authentication_required', retryable: false },
  forbidden: { classification: 'authorization_denied', retryable: false },
  not_found: { classification: 'not_found', retryable: false },
  internal_error: { classification: 'internal_error', retryable: true },
  nyxid_transport_context_required: { classification: 'authentication_required', retryable: false },
  request_digest_mismatch: { classification: 'digest_mismatch', retryable: false },
  run_identity_conflict: { classification: 'identity_conflict', retryable: false },
  idempotency_conflict: { classification: 'identity_conflict', retryable: false },
  invalid_idempotency_scope: { classification: 'invalid_request', retryable: false },
  idempotency_ledger_full: { classification: 'idempotency_capacity_exhausted', retryable: false },
  testing_placement_inputs_unverified: { classification: 'input_verification_rejected', retryable: false },
  testing_placement_denied: { classification: 'placement_denied', retryable: false },
  testing_placement_unavailable: { classification: 'no_eligible_machine', retryable: true },
  testing_placement_policy_unavailable: { classification: 'placement_service_unavailable', retryable: true },
  testing_placement_verifier_unavailable: { classification: 'placement_service_unavailable', retryable: true },
  testing_claim_signing_key_unavailable: { classification: 'testing_configuration_unavailable', retryable: true },
  testing_authorization_unavailable: { classification: 'authorization_service_unavailable', retryable: true },
  testing_fact_verifier_unavailable: { classification: 'runtime_fact_verifier_unavailable', retryable: true },
  nyxid_authorization_expired: { classification: 'authorization_expired', retryable: false },
  nyxid_authorization_mismatch: { classification: 'authorization_denied', retryable: false },
  nyxid_subject_mismatch: { classification: 'authorization_denied', retryable: false },
  nyxid_route_mismatch: { classification: 'authorization_denied', retryable: false },
  nyxid_client_correlation_mismatch: { classification: 'transport_binding_mismatch', retryable: false },
  nyxid_request_digest_mismatch: { classification: 'transport_binding_mismatch', retryable: false },
  stale_testing_machine: { classification: 'wrong_machine', retryable: false },
  stale_testing_worker: { classification: 'wrong_worker', retryable: false },
  stale_testing_attempt: { classification: 'stale_attempt', retryable: false },
  stale_testing_generation: { classification: 'stale_generation', retryable: false },
  stale_testing_fence: { classification: 'stale_fence', retryable: false },
  testing_lease_expired: { classification: 'lease_expired', retryable: false },
  invalid_testing_lease: { classification: 'invalid_lease', retryable: false },
  invalid_no_local_acceptance_fact: { classification: 'runtime_admission_fact_rejected', retryable: false },
  terminal_commit_conflict: { classification: 'conflicting_terminal_result', retryable: false },
  stale_terminal_binding: { classification: 'terminal_binding_mismatch', retryable: false },
  invalid_terminal_projection: { classification: 'invalid_terminal_result', retryable: false },
  cleanup_verifier_unavailable: { classification: 'cleanup_verifier_unavailable', retryable: true },
  invalid_cleanup_receipt: { classification: 'cleanup_receipt_rejected', retryable: false },
  external_schema_authority_unavailable: { classification: 'schema_authority_unavailable', retryable: true },
  invalid_external_schema_reference: { classification: 'schema_identity_rejected', retryable: false },
  invalid_cursor: { classification: 'invalid_request', retryable: false },
  cursor_expired: { classification: 'cursor_expired', retryable: true },
  concurrent_update: { classification: 'concurrent_update', retryable: true }
} as const;

export const publicErrorRetryable = (code: string, status: number): boolean => {
  const testingClassification = TESTING_PUBLIC_ERROR_CATALOG[code as keyof typeof TESTING_PUBLIC_ERROR_CATALOG];
  if (testingClassification !== undefined) return testingClassification.retryable;
  if (code === 'internal_error') return true;
  if (code === 'not_implemented') return false;
  return status === 429 || status >= 500;
};

export const notFound = (message: string): TalosError => new TalosError('not_found', message, 404);
export const unauthorized = (message: string): TalosError =>
  new TalosError('unauthorized', message, 401);
export const forbidden = (message: string): TalosError => new TalosError('forbidden', message, 403);
export const modeForbidden = (message: string): TalosError => new TalosError('mode_forbidden', message, 403);
export const conflict = (message: string): TalosError => new TalosError('conflict', message, 409);
export const actionAlreadyCompleted = (): TalosError =>
  new TalosError('action_already_completed', 'session action result was already stored', 409);
export const taskCancelled = (message = 'task was cancelled'): TalosError => new TalosError('task_cancelled', message, 409);
export const payloadTooLarge = (message = 'request body is too large'): TalosError => new TalosError('payload_too_large', message, 413);
export const deadlineExceeded = (message = 'task deadline has passed'): TalosError => new TalosError('deadline_exceeded', message, 409);
export const notImplemented = (message: string): TalosError =>
  new TalosError('not_implemented', message, 501);
