export class TalosError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TalosError';
    this.code = code;
    this.status = status;
  }
}

export const notFound = (message: string): TalosError => new TalosError('not_found', message, 404);
export const unauthorized = (message: string): TalosError =>
  new TalosError('unauthorized', message, 401);
export const forbidden = (message: string): TalosError => new TalosError('forbidden', message, 403);
export const conflict = (message: string): TalosError => new TalosError('conflict', message, 409);
export const taskCancelled = (message = 'task was cancelled'): TalosError => new TalosError('task_cancelled', message, 409);
export const payloadTooLarge = (message = 'request body is too large'): TalosError => new TalosError('payload_too_large', message, 413);
export const deadlineExceeded = (message = 'task deadline has passed'): TalosError => new TalosError('deadline_exceeded', message, 409);
export const notImplemented = (message: string): TalosError =>
  new TalosError('not_implemented', message, 501);
