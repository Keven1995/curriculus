CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  client_hash char(64) NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
  window_ms integer NOT NULL CHECK (window_ms > 0),
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, client_hash, window_ms, window_started_at),
  CHECK (expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_expires_at_idx
  ON rate_limit_buckets (expires_at);
