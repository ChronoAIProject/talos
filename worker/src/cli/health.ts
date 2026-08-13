export const checkControlPlaneHealth = async (
  controlPlaneUrl: string,
  fetcher: typeof fetch = fetch
): Promise<void> => {
  const healthUrl = new URL('/healthz', ensureTrailingSlash(controlPlaneUrl));
  try {
    const response = await fetcher(healthUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { status?: unknown };
    if (body.status !== 'ok') throw new Error('control plane reported degraded health');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`cannot reach ${healthUrl.toString()}: ${reason}. There is no public worker endpoint; connect this machine to the required VPN or in-network environment, then retry.`);
  }
};

const ensureTrailingSlash = (value: string): string => value.endsWith('/') ? value : `${value}/`;
