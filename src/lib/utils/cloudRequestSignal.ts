// Application wait budgets, not a provider SLA: 20s for a complete server
// operation and another 10s for browser/server transport and response handling.
export const providerOperationTimeoutMs = 20_000;
export const browserCloudRequestTimeoutMs = 30_000;

// The same signal remains attached through response-body consumption. Worker
// cancellation can stop reads; uploads use only the deadline because a started
// write must still be acknowledged or recorded as having an unknown outcome.
export function cloudRequestSignal(signal?: AbortSignal, timeoutMs = browserCloudRequestTimeoutMs): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
