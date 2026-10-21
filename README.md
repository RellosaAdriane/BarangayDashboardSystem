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

If your database was created before camera recordings were added, import [`database/camera_recordings_migration.sql`](database/camera_recordings_migration.sql) once through phpMyAdmin's **Import** tab. Existing recording tables receive the archive timestamp field from this migration.

For a database that already has those profile fields, import [`database/middle_name_migration.sql`](database/middle_name_migration.sql) once to add the optional middle name field.

The SQL file creates an empty database. It does not insert a preset user or password. Passwords must be stored as secure hashes by the application; do not insert a plain-text password into `users.password_hash`.

For an existing database, import [`database/calendar_events_migration.sql`](database/calendar_events_migration.sql) once to add the shared events calendar.

For an existing database, import [`database/task_duty_migration.sql`](database/task_duty_migration.sql) once to add required duty start and end times to assigned tasks.

## Role permissions

- **Tanod:** view camera feeds, read incident history, announcements, and shared calendar events, and view assigned tasks.
- **Barangay Captain:** view feeds, submit reports, assign Tanod duties with a work description and scheduled start/end time, and create shared calendar events.
- **Admin:** configure camera URLs, manage/archive records, view camera totals and online status, assign user roles, and edit captain-created calendar events.

`users.role` uses `tanod`, `captain`, or `admin`. Camera availability is represented by `cameras.last_status`; archived records stay in the database and can be filtered from the public dashboard.

## Configure and run

1. Add the settings from `.env.example` to your existing `.env` (or copy the example if you do not have one), then set the MySQL details to match XAMPP. A default XAMPP install commonly uses `root` with an empty password; use the credentials configured on your computer. Keep any camera/CompreFace values already in `.env`.
2. Set `SESSION_SECRET` to a long random value.
3. Install dependencies and start the app:

```bash
npm install
npm start
```

4. Open `http://localhost:3000`. The public landing page has **Log in** and **Create account** actions. If there is no approved admin yet, the first account flow creates the administrator (password must be 8–16 characters).
5. Other users can request Tanod or Barangay Captain access from **Create account**. Their accounts stay pending and cannot log in until an admin approves them. Admins can approve or decline requests from the **Account requests** panel.
6. Use the Admin panel to add cameras and create accounts directly when needed.

The public landing page does not expose dashboard data. Approved users must log in before dashboard APIs are available. A declined username remains reserved in the account table; an admin should contact the applicant if a correction and resubmission are needed.

The app now stores accounts and operational records in MySQL and checks roles on the server:

- **Tanod:** view feeds, read incident history and announcements, and update assigned task status.
- **Barangay Captain:** all Tanod viewing, submit incident reports, publish announcements, and assign tasks.
- **Admin:** all features, configure/archive cameras, archive incidents, view counts, create accounts, and change roles.

The camera online total reflects a feed that the dashboard has successfully loaded. Camera stream URLs must be reachable by the browser on the user's network. For real use, serve the app over HTTPS and use a persistent session store instead of the development memory store.

## Past camera footage playback

The server records every enabled, unarchived camera as five-minute H.264 MP4 clips. This requires FFmpeg on the Node.js server. The ESP32-CAM URL must be a stream endpoint FFmpeg can read, typically the camera's MJPEG `/stream` URL. CompreFace recognition continues to use its separate snapshot URL.

1. Install FFmpeg on the computer running Node.js. In a new terminal, run `ffmpeg -version` to confirm it is available. If it is not on `PATH`, set `FFMPEG_PATH` in `.env` to its executable, for example `C:/ffmpeg/bin/ffmpeg.exe` on Windows.
2. For an existing database, import `database/camera_recordings_migration.sql` once. Fresh installs get the table from `database/barangay_dashboard.sql`.
3. Add these settings to `.env` (they are also in `.env.example`):

   ```dotenv
   FFMPEG_PATH=ffmpeg
   RECORDINGS_DIR=./storage/recordings
   RECORDING_SEGMENT_SECONDS=300
   ```

   Segment duration can be set from 60 to 900 seconds. The recordings directory contains the MP4 files; keep it on a disk with enough free space and include it in your backup plan.
4. Restart the Node.js app. It starts a recorder for each enabled camera and retries when a stream disconnects. Save a reachable ESP32-CAM stream URL in Admin camera settings. New clips appear after each segment closes.
5. Open **Recorded Footage** in the camera dashboard. Choose a camera and a from/to date and time, select **Search clips**, then select **Play**. All signed-in dashboard roles can view recordings.

The recorder converts the camera stream to H.264 at 10 frames per second and approximately 500 kbit/s to keep clips broadly playable. At that bitrate, budget roughly 225 MB per camera per hour; actual usage varies with the scene. Clips are stored on the Node.js host, not on the ESP32-CAM, and the stream must be reachable from that host. Admins can archive clips and restore them for up to one year. The server automatically deletes archived clips after one year, checking at startup and then daily. Keep the dashboard on a trusted network because footage may contain identifiable people.

Face recognition remains optional; configure its values in `.env`. The example uses a 0.7 face-detection confidence threshold and a 0.85 identity similarity threshold to reduce false detections and false matches. Higher thresholds can miss faces, especially in dim or low-resolution footage. For better results, use a clear, well-lit, front-facing camera image and enroll each person with several varied, good-quality images in CompreFace. Restart the app after changing `.env`. Keep API credentials private and do not expose this dashboard publicly without HTTPS.
