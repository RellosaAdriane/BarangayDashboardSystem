USE barangay_dashboard;

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

ALTER TABLE camera_recordings ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL;
CREATE INDEX IF NOT EXISTS idx_recordings_archive ON camera_recordings (archived_at);
