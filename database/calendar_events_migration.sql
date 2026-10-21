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
