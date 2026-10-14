export type RateLimitPolicy = {
  limit: number;
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/** Shared stores receive a keyed client digest, never the source IP itself. */
export interface DistributedRateLimitStore {
  consume(
    scope: string,
    clientKey: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitDecision>;
}
