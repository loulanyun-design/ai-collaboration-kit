export const MODEL_POLICY = Object.freeze({
  retrieval: "gpt-5.6-luna",
  execution: "gpt-5.6-sol",
  escalation: "gpt-6-astra"
});

export const DEFAULT_MODEL_ROUTE = "execution";
export const TIMEOUT_POLICY_VERSION = "p0-v1";

export const MODEL_ROUTE_TIMEOUT_POLICIES = Object.freeze({
  retrieval: Object.freeze({
    version: TIMEOUT_POLICY_VERSION,
    launchTimeoutMs: 60000,
    idleObservationMs: 180000,
    maxRuntimeMs: 10 * 60 * 1000
  }),
  execution: Object.freeze({
    version: TIMEOUT_POLICY_VERSION,
    launchTimeoutMs: 90000,
    idleObservationMs: 300000,
    maxRuntimeMs: 30 * 60 * 1000
  }),
  escalation: Object.freeze({
    version: TIMEOUT_POLICY_VERSION,
    launchTimeoutMs: 120000,
    idleObservationMs: 600000,
    maxRuntimeMs: 45 * 60 * 1000
  })
});

// Backward-compatible view used by older callers/tests. This is the absolute
// max runtime, not a generic "silence" timeout.
export const MODEL_ROUTE_TIMEOUTS = Object.freeze(
  Object.fromEntries(
    Object.entries(MODEL_ROUTE_TIMEOUT_POLICIES)
      .map(([route, policy]) => [route, policy.maxRuntimeMs])
  )
);

export function resolveModelRoute(value) {
  const route = String(value || DEFAULT_MODEL_ROUTE).trim().toLowerCase();
  if (!Object.hasOwn(MODEL_POLICY, route)) {
    throw new Error("unsupported model route: " + route);
  }
  return route;
}

export function modelForRoute(value) {
  return MODEL_POLICY[resolveModelRoute(value)];
}

export function timeoutPolicyForRoute(value) {
  const policy = MODEL_ROUTE_TIMEOUT_POLICIES[resolveModelRoute(value)];
  return { ...policy };
}

export function timeoutForRoute(value) {
  return timeoutPolicyForRoute(value).maxRuntimeMs;
}
