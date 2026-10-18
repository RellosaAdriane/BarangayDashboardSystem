-- Run this once in phpMyAdmin for an existing barangay_dashboard database.
-- Existing accounts remain approved. New self-registrations are pending review.
USE barangay_dashboard;

ALTER TABLE users
  ADD COLUMN approval_status ENUM('pending', 'approved', 'declined') NOT NULL DEFAULT 'approved' AFTER is_active,
  ADD COLUMN requested_role ENUM('tanod', 'captain') NULL AFTER approval_status,
  ADD COLUMN reviewed_by BIGINT UNSIGNED NULL AFTER requested_role,
  ADD COLUMN reviewed_at DATETIME NULL AFTER reviewed_by,
  ADD INDEX idx_users_approval (approval_status, created_at),
  ADD CONSTRAINT fk_users_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
