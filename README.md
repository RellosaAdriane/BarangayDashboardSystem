# BarangayPOB-3A Dashboard

## MySQL database for XAMPP

The import file is [`database/barangay_dashboard.sql`](database/barangay_dashboard.sql). It creates the `barangay_dashboard` database and tables for users/roles, cameras, incident reports/history, dashboard announcements, assigned tasks, and audit logs.

To import it:

1. Start **MySQL** in the XAMPP Control Panel.
2. Open `http://localhost/phpmyadmin`.
3. Select **Import**, choose `database/barangay_dashboard.sql`, then click **Import** at the bottom.
4. Confirm that `barangay_dashboard` appears in the left sidebar.

If you imported the original database file before account approval was added, import [`database/registration_approval_migration.sql`](database/registration_approval_migration.sql) once as well. This adds the approval fields while keeping existing user accounts approved.

If you imported the database before profile fields were added, import [`database/user_profile_migration.sql`](database/user_profile_migration.sql) once. New first-admin setup and registration ask for first name, last name, gender, and date of birth.

For a database that already has those profile fields, import [`database/middle_name_migration.sql`](database/middle_name_migration.sql) once to add the optional middle name field.

The SQL file creates an empty database. It does not insert a preset user or password. Passwords must be stored as secure hashes by the application; do not insert a plain-text password into `users.password_hash`.

## Role permissions

- **Tanod:** view camera feeds, read incident history and announcements, and view assigned tasks.
- **Barangay Captain:** view feeds, submit reports, publish announcements, and assign tasks.
- **Admin:** configure camera URLs, manage/archive records, view camera totals and online status, and assign user roles.

`users.role` uses `tanod`, `captain`, or `admin`. Camera availability is represented by `cameras.last_status`; archived records stay in the database and can be filtered from the public dashboard.

## Configure and run

1. Add the settings from `.env.example` to your existing `.env` (or copy the example if you do not have one), then set the MySQL details to match XAMPP. A default XAMPP install commonly uses `root` with an empty password; use the credentials configured on your computer. Keep any camera/CompreFace values already in `.env`.
2. Set `SESSION_SECRET` to a long random value.
3. Install dependencies and start the app:

```bash
npm install
npm start
```

4. Open `http://localhost:3000`. The public landing page has **Log in** and **Create account** actions. If there is no approved admin yet, the first account flow creates the administrator (password must be at least 10 characters).
5. Other users can request Tanod or Barangay Captain access from **Create account**. Their accounts stay pending and cannot log in until an admin approves them. Admins can approve or decline requests from the **Account requests** panel.
6. Use the Admin panel to add cameras and create accounts directly when needed.

The public landing page does not expose dashboard data. Approved users must log in before dashboard APIs are available. A declined username remains reserved in the account table; an admin should contact the applicant if a correction and resubmission are needed.

The app now stores accounts and operational records in MySQL and checks roles on the server:

- **Tanod:** view feeds, read incident history and announcements, and update assigned task status.
- **Barangay Captain:** all Tanod viewing, submit incident reports, publish announcements, and assign tasks.
- **Admin:** all features, configure/archive cameras, archive incidents, view counts, create accounts, and change roles.

The camera online total reflects a feed that the dashboard has successfully loaded. Camera stream URLs must be reachable by the browser on the user's network. For real use, serve the app over HTTPS and use a persistent session store instead of the development memory store.

Face recognition remains optional; configure its values in `.env`. The example uses a 0.7 face-detection confidence threshold and a 0.85 identity similarity threshold to reduce false detections and false matches. Higher thresholds can miss faces, especially in dim or low-resolution footage. For better results, use a clear, well-lit, front-facing camera image and enroll each person with several varied, good-quality images in CompreFace. Restart the app after changing `.env`. Keep API credentials private and do not expose this dashboard publicly without HTTPS.
