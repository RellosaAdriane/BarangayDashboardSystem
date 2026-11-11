# Barangay Dashboard

Barangay dashboard application using Supabase PostgreSQL and Storage, with the Express app hosted on Vercel.

## Supabase setup

1. In the Supabase SQL Editor, run `database/barangaywatch_supabase_schema.sql` to create the application tables.
2. Run [`database/supabase_runtime_tables.sql`](database/supabase_runtime_tables.sql) before deploying. It creates the calendar and camera-recording metadata tables used by the app.
3. Create private Storage buckets named `task-proofs` and `camera-evidence`.
4. Copy the PostgreSQL connection string from **Project Settings → Database**. For Vercel, use Supabase's transaction pooler connection string where available.

The supplied schema enables row level security without client policies. The dashboard connects from its server using `DATABASE_URL`; browser clients must not receive database credentials or the service role key.

## Vercel setup

Configure these Production and Preview environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `DATABASE_SSL` | `true` |
| `DB_POOL_MAX` | `5` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key; keep it server-only |
| `SESSION_SECRET` | Random secret of at least 32 characters; keep it stable across redeploys for each environment |
| `CAMERA_RELAY_BASE_URL` | Public HTTPS URL for the camera relay, such as `https://stream.example.com` |
| `CAMERA_RELAY_SECRET` | Same private random secret configured on the relay |

Deploy the project. The Express app trusts Vercel's HTTPS proxy so secure session cookies persist in the browser. The first user can complete initial admin setup from the landing page. New accounts request Tanod or Barangay Captain access and appear in Account management for admin review.

## Local development

1. Copy `.env.example` to `.env` and fill in the Supabase values.
2. Install packages and start the app:

   ```sh
   npm install
   npm start
   ```

3. Open `http://localhost:3000`.

## Camera notes

The ESP32-CAM stream is on the camera's private network. For remote viewing, configure an authenticated HTTPS relay on an always-on host that can reach the camera. Do not expose the camera's raw stream port to the public internet. Configure `CAMERA_RELAY_BASE_URL` and the matching `CAMERA_RELAY_SECRET` in Vercel.

## Existing features

- **Tanod:** view camera feeds, incident history, announcements, calendar events, and assigned duties; submit task completion proof.
- **Barangay Captain:** view feeds, submit incident reports, publish announcements, assign Tanod duties, create calendar events, and review task proof.
- **Admin:** manage cameras and accounts, approve registration requests, archive records, and edit captain-created calendar events.

Passwords are hashed with bcrypt. Login and role checks run on the server.


Download CompreFace_1.2.0.zip archive or run:
wget -q -O tmp.zip 'https://github.com/exadel-inc/CompreFace/releases/download/v1.2.0/CompreFace_1.2.0.zip' && unzip tmp.zip && rm tmp.zip
To start CompreFace run:
docker-compose up -d
Open in your browser: http://localhost:8000/login
To stop properly run:
docker-compose stop
To start again run:
docker-compose start
More detailed install guide(and Windows instructions) is on our readme﻿ page.