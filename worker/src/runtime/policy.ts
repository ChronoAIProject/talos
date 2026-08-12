export interface HandoffPolicy {
  isMasked: boolean;
  startHandoff(): HandoffPolicy;
  endHandoff(): HandoffPolicy;
}

export const createHandoffPolicy = (): HandoffPolicy => {
  const policy: HandoffPolicy = {
    isMasked: false,
    startHandoff: () => ({ ...policy, isMasked: true }),
    endHandoff: () => ({ ...policy, isMasked: false })
  };
  return policy;
};
