USE barangay_dashboard;

ALTER TABLE tasks
  ADD COLUMN proof_description TEXT NULL AFTER completed_at,
  ADD COLUMN proof_image VARCHAR(255) NULL AFTER proof_description,
  ADD COLUMN proof_submitted_at DATETIME NULL AFTER proof_image,
  ADD COLUMN proof_status ENUM('Pending', 'Approved', 'Rejected') NULL AFTER proof_submitted_at,
  ADD COLUMN proof_reviewed_by BIGINT UNSIGNED NULL AFTER proof_status,
  ADD COLUMN proof_reviewed_at DATETIME NULL AFTER proof_reviewed_by;

CREATE INDEX idx_tasks_proof_review ON tasks (proof_status, assigned_by);
