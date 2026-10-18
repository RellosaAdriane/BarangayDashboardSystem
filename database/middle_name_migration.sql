-- Run once in phpMyAdmin for databases that already have the profile fields.
USE barangay_dashboard;

ALTER TABLE users
  ADD COLUMN middle_name VARCHAR(60) NULL AFTER first_name;
