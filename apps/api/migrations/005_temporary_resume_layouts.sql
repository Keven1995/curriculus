CREATE TABLE IF NOT EXISTS temporary_resume_layouts (
  id uuid PRIMARY KEY,
  template jsonb NOT NULL CHECK (jsonb_typeof(template) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT temporary_resume_layouts_expiration_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS temporary_resume_layouts_expiration_idx
  ON temporary_resume_layouts (expires_at);
