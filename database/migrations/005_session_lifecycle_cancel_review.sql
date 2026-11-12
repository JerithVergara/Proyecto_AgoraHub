-- Ciclo de vida de tutorías: llamada externa, revisión pendiente y cancelación.
-- Ejecutar en el SQL Editor de Supabase después de 004_selected_tutor_availability.sql.
-- No elimina tablas ni vistas existentes.
SET search_path TO agorahub, public;

ALTER TABLE tutoring_sessions
  DROP CONSTRAINT IF EXISTS tutoring_sessions_status_check;

ALTER TABLE tutoring_sessions
  ADD CONSTRAINT tutoring_sessions_status_check
  CHECK (status IN ('scheduled', 'in_progress', 'review_pending', 'completed', 'cancelled', 'no_show'));

CREATE INDEX IF NOT EXISTS ix_sessions_status_time
  ON tutoring_sessions(status, starts_at);

GRANT SELECT, INSERT, UPDATE ON tutoring_sessions TO service_role;
