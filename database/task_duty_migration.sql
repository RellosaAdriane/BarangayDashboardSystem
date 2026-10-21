ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS duty_starts_at DATETIME NULL AFTER due_at,
  ADD COLUMN IF NOT EXISTS duty_ends_at DATETIME NULL AFTER duty_starts_at;

CREATE INDEX IF NOT EXISTS idx_tasks_duty ON tasks (duty_starts_at, duty_ends_at);
