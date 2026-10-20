import type { Env } from '../db';

/** Fail closed: only an explicit opt-out can expose separately metered bindings. */
export function restrictedCosts(env: Partial<Env>): boolean {
  return env.COST_MODE !== 'unrestricted';
}

export function applyCostPolicy(env: Env): Env {
  if (!restrictedCosts(env)) return env;
  return { ...env, MEDIA_BUCKET: undefined, MINATTO_KV: undefined, AI: undefined,
    HYPERDRIVE: undefined, WATCH_PARTY: undefined, GITHUB_TOKEN: undefined };
}
