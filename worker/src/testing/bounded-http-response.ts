export class BoundedHttpResponseError extends Error {
  public constructor() {
    super('HTTP response exceeds the bounded limit');
    this.name = 'BoundedHttpResponseError';
  }
}

export const readBoundedResponseText = async (response: Response, maxBytes: number): Promise<string> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) throw new BoundedHttpResponseError();
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* the size violation remains authoritative */ }
        throw new BoundedHttpResponseError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};
