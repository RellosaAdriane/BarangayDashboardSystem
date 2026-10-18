-- Run once in phpMyAdmin for an existing barangay_dashboard database.
USE barangay_dashboard;

ALTER TABLE users
  ADD COLUMN first_name VARCHAR(60) NULL AFTER full_name,
  ADD COLUMN last_name VARCHAR(60) NULL AFTER first_name,
  ADD COLUMN gender ENUM('female', 'male') NULL AFTER last_name,
  ADD COLUMN date_of_birth DATE NULL AFTER gender;

-- Existing full_name values are retained; fill profile fields for existing
-- accounts through the account recovery/profile flow as appropriate.
