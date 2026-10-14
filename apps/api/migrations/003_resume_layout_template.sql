ALTER TABLE analysis_sessions
  ADD COLUMN IF NOT EXISTS resume_layout_template jsonb;

ALTER TABLE analysis_sessions
  DROP CONSTRAINT IF EXISTS analysis_sessions_content_state_check;

ALTER TABLE analysis_sessions
  ADD CONSTRAINT analysis_sessions_content_state_check CHECK (
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
      AND resume_layout_template IS NULL
      AND document_storage_key IS NOT NULL
      AND document_created_at IS NOT NULL
    )
  );
