# Barangay Dashboard

Barangay dashboard application using Supabase PostgreSQL and Storage, with the Express app hosted on Vercel.

## Supabase setup

1. In the Supabase SQL Editor, run `database/barangaywatch_supabase_schema.sql` to create the application tables.
2. Run [`database/supabase_runtime_tables.sql`](database/supabase_runtime_tables.sql) before deploying. It creates the calendar and camera-recording metadata tables used by the app.
3. Create private Storage buckets named `task-proofs` and `camera-evidence`. Set the `camera-evidence` bucket's upload limit to 250 MB or lower, within your Supabase project's allowed limit.
4. Copy the PostgreSQL connection string from **Project Settings → Database**. For Vercel, use Supabase's transaction pooler connection string where available.

The supplied schema enables row level security without client policies. The dashboard connects from its server using `DATABASE_URL`; browser clients must not receive database credentials or the service role key.

Connecting a saved camera starts face monitoring in the open browser dashboard. face-api.js compares detected faces with admin-enrolled persons. Only frames containing unmatched faces create a JPEG snapshot in **Alerts**. Captain and admin can review a snapshot as **Recognized** or **Report**, with notes, reviewer and review time. Review does not create a face enrollment. Monitoring requires an open connected dashboard; it is not a background camera service.

The server creates or upgrades `camera_alerts` and `report_notifications` on first use from the matching SQL files in `database/` (or run those files with your database owner before starting). JPEG snapshots are stored in PostgreSQL, up to 400 KB each, and served only to signed-in users. Submissions are limited to one snapshot per camera per 60 seconds across viewers. Alerts shows pending snapshots by default. Reviewed snapshots automatically appear in **Archive**, including past approved/dismissed reviews; pending snapshots stay until reviewed. **Reports** filters snapshots marked Report for follow-up. All views use pages of 20 snapshots. Archiving preserves images, reviewer, notes and timestamps; it does not delete data or reduce database storage.

Marking a new snapshot **Report** saves one notification per currently active, approved Tanod/Captain account, in the same transaction as the review. Their dashboard header has a **Notifications** button combining reported snapshots and published announcements. It polls every five seconds, shows a combined unread count, and opens the exact snapshot or full announcement when clicked. Each account has its own read state. Announcement reads are stored in `announcement_reads`, created on first use from `database/announcement_reads.sql`; all currently published announcements without a read record appear unread. Hidden announcements are excluded. Notifications remain available after logging in later, even if the recipient was offline when reported. Past reports are not backfilled. Enable browser notifications from the Notifications inbox for an optional desktop notification while the dashboard is open; browser permission is required. Closed dashboards do not receive push/SMS/email notifications. Report does not create an incident record or notify newly approved users retroactively.

Reported snapshots display **Awaiting action** until a Tanod, Captain or Admin opens the preview, describes the action taken and presses **Mark as actioned**. The server records the actor, timestamp and notes, and adds an audit event in the same transaction. Once actioned, the report automatically leaves the active Reports list and notification inbox (including its unread count), and appears in **Archive** with an **Actioned** badge. Reports awaiting action stay out of Archive. This also applies to previously actioned reports; no manual migration or archive action is needed. Reading a notification does not resolve a report. The recorded action cannot be overwritten by another submission. Captain accounts cannot open Archive.

## Admin password reset

Under **Account management → Approved Tanod and Captain accounts**, choose **Reset Password** beside an account. Enter and confirm a new password of 8–16 characters. Only admins can reset approved Tanod/Captain accounts; this action cannot reset administrator or pending accounts. The password is hashed with bcrypt, the target's existing sessions are removed, and a `password_reset` audit event is saved in the same transaction. Passwords are never returned in the API response or stored in audit details. Tell the account holder their new password so they can log in again.

## Face Management on localhost

Run `npm start` and open `http://localhost:3000`. Sign in as admin and choose **Face Management**. Enter a name and upload one clear, front-facing picture (JPEG/PNG/WebP, up to 4 MB). Enrollment requires exactly one detected face. **Enrolled Faces** shows saved persons; **Remove Person** deletes their picture and descriptor. Enrollment/removal also creates an `audit_logs` entry. No Vercel deployment is needed for this local version.

The Node server uses the PostgreSQL database configured by `DATABASE_URL` in `.env`, even when accessed on localhost. Use a separate development database if local enrollment data should be separate from production. `database/enrolled_faces.sql` creates the enrollment table on first use. `database/camera_alerts.sql` upgrades old review status constraints without deleting past snapshots. These are PostgreSQL schemas; the MariaDB reference file does not configure this Node app.

All three required face-api.js models are bundled under `public/models`: Tiny Face Detector, 68-point landmarks and face recognition. Descriptors are computed in the browser; there is no external face recognition service. Enrollment photos and 128-value descriptors are stored server-side in PostgreSQL with RLS enabled. Enrollment management and photos are admin-only; signed-in camera viewers can fetch descriptors for browser matching. Face data is never stored in localStorage. Matching refreshes enrollments every three seconds during monitoring and immediately after changes in the same tab. The distance threshold is `0.5` in `public/faces.js`; matches are approximate and are not an authentication mechanism or liveness check. If enrollment refresh fails, the browser shows an error instead of treating all faces as unknown.

Save the camera URL before connecting to enable monitoring. Enrolled matches are shown in green, unmatched faces in orange. The alert snapshot contains the captured frame, which may also include enrolled persons; its face count is the number of unmatched faces. Keep the dashboard open and detection running. Test real camera lighting and enrollment pictures locally before relying on matches.

## Vercel setup

Runtime SQL is bundled as the JavaScript module `database/runtime-schemas.js` so serverless functions do not depend on deployed `.sql` files. After editing any runtime schema, run `npm run generate:schemas`. Vercel runs the same generator through `vercel-build`. The regression tests also run the affected endpoints from a bundle containing no SQL files.

Configure these Production and Preview environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `DATABASE_SSL` | `true` |
| `DB_POOL_MAX` | `5` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key used for signed browser uploads |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key; keep it server-only |
| `SESSION_SECRET` | Random secret of at least 32 characters; keep it stable across redeploys for each environment |
| `CAMERA_RELAY_BASE_URL` | Public HTTPS URL for the camera relay, such as `https://stream.example.com` |
| `CAMERA_RELAY_SECRET` | Same private random secret configured on the relay |

Deploy the project. The Express app trusts Vercel's HTTPS proxy so secure session cookies persist in the browser. The first user can complete initial admin setup from the landing page. New accounts request Tanod or Barangay Captain access and appear in Account management for admin review.

## Render setup

The root `render.yaml` deploys the full dashboard as a Node web service. Push the project, including `scripts/` and `database/`, to GitHub, then create a Render Blueprint from this repository. Supply the Supabase environment values when prompted. The Blueprint generates a session secret, installs dependencies, generates runtime schemas, starts the root `server.js`, and checks `/api/health` for database connectivity. The app trusts Render's HTTPS proxy so secure login cookies work.

For an existing Render web service, use the repository root, build command `npm ci && npm run generate:schemas`, and start command `npm start`. Set `NODE_ENV=production`, `NODE_VERSION=24`, the Supabase/database variables listed above, and a stable `SESSION_SECRET`. If you use an HTTPS camera relay, also set `CAMERA_RELAY_BASE_URL` and `CAMERA_RELAY_SECRET`. The cloud camera gateway is a separate service and is not deployed by this Blueprint.

## Local development

1. Copy `.env.example` to `.env` and fill in the Supabase values.
2. Install packages and start the app:

   ```sh
   npm install
   npm start
   ```

3. Open `http://localhost:3000` on the computer running the app. The server also prints that computer's Wi-Fi/LAN address (for example `http://192.168.1.20:3000`). Open that address on each phone or computer on the same Wi-Fi. The host computer must stay on and running `npm start` while others use the dashboard. If Windows Firewall asks, allow Node.js on your **Private networks**.

## Camera notes

Every enabled, unarchived camera saved in **Camera Setup** has its own window in **Live Camera Feed**. Adding a camera refreshes the grid immediately for that admin; other open dashboards pick it up through the existing 20-second camera refresh. Each window connects automatically and has independent reconnect, disconnect and fullscreen controls. Admins can use **Edit stream URL** in each window. Status refreshes keep existing streams running, while removing/disabling a camera releases its stream and window. Face monitoring checks connected cameras in turn and saves unmatched snapshots with the correct camera ID and a separate cooldown for each camera. Keep the dashboard open for monitoring.

For same-Wi-Fi viewing, save the ESP32-CAM's stream URL (usually `http://CAMERA_IP:81/stream`, for example `http://192.168.1.6:81/stream`). Open the Vercel dashboard in updated Chrome or Edge, select **Connect Camera**, and **Allow** Local network access when prompted. The browser connects directly to the camera; no HTTPS relay is required for same-Wi-Fi viewing. If access was denied, change Local network access in the site's browser settings and reconnect. The camera and viewer must be reachable on the same LAN (guest Wi-Fi/client isolation can prevent this). The ESP32 firmware must send `Access-Control-Allow-Origin: *` on the stream, as the included firmware does, so snapshot detection can read frames. Close other camera viewers if the ESP32 only serves one stream at a time. Reserve a fixed camera IP in the router.

Browsers without support for local HTTP access from HTTPS must use the local dashboard address printed by `npm start`, or an HTTPS relay running on a device that can reach the camera. Vercel servers cannot reach a camera's private Wi-Fi IP. A relay or tunnel is still required for viewers outside that Wi-Fi. Do not expose the camera's raw stream port to the public internet. See [Chrome's Local Network Access documentation](https://developer.chrome.com/blog/local-network-access).

## Existing features

- **Tanod:** view camera feeds, snapshot alerts, announcements, calendar events, and assigned duties; submit task completion proof.
- **Barangay Captain:** view feeds, review snapshot alerts, publish announcements, assign Tanod duties, create calendar events, and review task proof.
- **Admin:** manage cameras and accounts, approve registration requests, review snapshot alerts, archive records, and edit captain-created calendar events.

Passwords are hashed with bcrypt. Login and role checks run on the server.
