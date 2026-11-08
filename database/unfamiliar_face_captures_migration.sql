USE barangay_dashboard;

CREATE TABLE IF NOT EXISTS unfamiliar_face_captures (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  image_file VARCHAR(80) NOT NULL,
  face_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('pending', 'kilala', 'hindi') NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_unfamiliar_face_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_unfamiliar_face_status (status, captured_at)
) ENGINE=InnoDB;
