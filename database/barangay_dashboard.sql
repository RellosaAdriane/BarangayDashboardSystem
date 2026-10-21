-- BarangayPOB-3A database for MySQL/MariaDB in XAMPP.
-- Import this file in phpMyAdmin (Import tab). It creates the database and tables.

CREATE DATABASE IF NOT EXISTS barangay_dashboard
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE barangay_dashboard;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  first_name VARCHAR(60) NULL,
  middle_name VARCHAR(60) NULL,
  last_name VARCHAR(60) NULL,
  gender ENUM('female', 'male') NULL,
  date_of_birth DATE NULL,
  username VARCHAR(60) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('tanod', 'captain', 'admin') NOT NULL DEFAULT 'tanod',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  approval_status ENUM('pending', 'approved', 'declined') NOT NULL DEFAULT 'approved',
  requested_role ENUM('tanod', 'captain') NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_users_approval (approval_status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cameras (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  stream_url VARCHAR(2048) NOT NULL,
  location VARCHAR(200) NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_status ENUM('unknown', 'online', 'offline') NOT NULL DEFAULT 'unknown',
  last_checked_at DATETIME NULL,
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cameras_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_cameras_visible (is_archived, is_enabled)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS camera_recordings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  camera_id BIGINT UNSIGNED NOT NULL,
  file_name VARCHAR(100) NOT NULL,
  started_at DATETIME NOT NULL,
  ended_at DATETIME NOT NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  file_size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  archived_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_recordings_camera FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
  UNIQUE KEY uq_recordings_camera_file (camera_id, file_name),
  INDEX idx_recordings_camera_time (camera_id, started_at),
  INDEX idx_recordings_time (started_at, ended_at),
  INDEX idx_recordings_archive (archived_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incidents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference_no VARCHAR(24) NOT NULL UNIQUE,
  type VARCHAR(100) NOT NULL,
  note TEXT NULL,
  status ENUM('Active', 'Resolved', 'Archived') NOT NULL DEFAULT 'Active',
  camera_id BIGINT UNSIGNED NULL,
  reported_by BIGINT UNSIGNED NULL,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_incidents_camera FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE SET NULL,
  CONSTRAINT fk_incidents_reporter FOREIGN KEY (reported_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_incidents_history (status, occurred_at),
  INDEX idx_incidents_archived (archived_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS announcements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  body TEXT NOT NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  published_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_announcements_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_announcements_dashboard (is_published, published_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  details TEXT NULL,
  location VARCHAR(200) NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_calendar_events_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_calendar_events_updater FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_calendar_events_dates (starts_at, ends_at),
  INDEX idx_calendar_events_creator (created_by)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  details TEXT NULL,
  status ENUM('Pending', 'In Progress', 'Completed', 'Cancelled') NOT NULL DEFAULT 'Pending',
  assigned_to BIGINT UNSIGNED NULL,
  assigned_by BIGINT UNSIGNED NULL,
  due_at DATETIME NULL,
  duty_starts_at DATETIME NULL,
  duty_ends_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tasks_assignee FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_assigner FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_tasks_assignee (assigned_to, status, due_at),
  INDEX idx_tasks_duty (duty_starts_at, duty_ends_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  details JSON NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_date (created_at)
) ENGINE=InnoDB;

-- No default account is created. Create the first admin through the app's
-- one-time setup flow (after the API is configured), using a strong password.
