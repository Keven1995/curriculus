ALTER TABLE analysis_sessions
  ADD COLUMN IF NOT EXISTS document_layout_fallback boolean NOT NULL DEFAULT false;
