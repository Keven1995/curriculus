CREATE TABLE IF NOT EXISTS analysis_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'analysis_ready'
    CHECK (status IN ('analysis_ready', 'document_ready')),
  job_url text,
  job_description text,
  resume text,
  analysis_result jsonb,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  estimated_cost_usd numeric(18, 12),
  document_storage_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  document_created_at timestamptz,
  CONSTRAINT analysis_sessions_content_state_check CHECK (
    (
      status = 'analysis_ready'
      AND job_description IS NOT NULL
      AND resume IS NOT NULL
      AND analysis_result IS NOT NULL
      AND document_storage_key IS NULL
      AND document_created_at IS NULL
    )
    OR
    (
      status = 'document_ready'
      AND job_url IS NULL
      AND job_description IS NULL
      AND resume IS NULL
      AND analysis_result IS NULL
      AND document_storage_key IS NOT NULL
      AND document_created_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS analysis_sessions_expiration_idx
  ON analysis_sessions (expires_at);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid UNIQUE REFERENCES analysis_sessions(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL DEFAULT 199 CHECK (amount_cents = 199),
  currency char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'refunded')),
  provider_payment_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  checkout_expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_status_checkout_expiration_idx
  ON orders (status, checkout_expires_at);
