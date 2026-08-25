import { WorkerClientError } from '../runtime/errors.js';
import { TestingAuthorizationResolverError } from './authorization-resolver.js';
import { LocalQARuntimeAdapterError } from './runtime-adapter.js';

const MAX_SAFE_LOG_ERROR_LENGTH = 256;

interface TrustedExecutorError extends Error {
  readonly code: string;
}

export const safeTestingErrorMessage = (
  error: unknown,
  isExecutorError: (error: unknown) => error is TrustedExecutorError =
    (_error: unknown): _error is TrustedExecutorError => false
): string => {
  let message: string;
  if (isExecutorError(error)) {
    message = `${error.code}: ${error.message}`;
  } else if (error instanceof WorkerClientError) {
    message = `testing_control_plane_error (${error.status})`;
  } else if (error instanceof LocalQARuntimeAdapterError) {
    message = error.status === undefined ? 'local_qa_runtime_error' : `local_qa_runtime_error (${error.status})`;
  } else if (error instanceof TestingAuthorizationResolverError) {
    message = error.status === undefined
      ? 'testing_authorization_error'
      : `testing_authorization_error (${error.status})`;
  } else {
    message = 'unexpected_error';
  }
  return message.slice(0, MAX_SAFE_LOG_ERROR_LENGTH);
};
