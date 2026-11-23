# AI Thinker ESP32-CAM → Vercel → Cloudflare R2

This version records silent, 60-second QVGA (320×240), approximately 5 FPS MJPEG AVI clips on the camera's microSD card. The camera requests a signed URL from the existing Express API, uploads directly to a private R2 bucket, then confirms the recording. Supabase continues storing metadata and accounts. Render and FFmpeg are not used. The dashboard decodes the AVI's JPEG frames in the browser, including pause and seek; it does not depend on native AVI support in `<video>`.

The code can be compiled and tested without R2 credentials. Real uploads, sustained recording performance and camera power/SD reliability must be tested on the actual board.

## 1. Create a private R2 bucket

In Cloudflare Dashboard, open **R2 Object Storage**, enable R2 if necessary, and create `barangaywatch-recordings`. Review Cloudflare's billing terms during account setup; the application does not create a bucket or purchase a plan for you. Leave public access disabled.

Create R2 S3 credentials with **Object Read & Write**, restricted to this bucket. Copy the Account ID, Access Key ID and Secret Access Key to local `.env` and **Vercel → your dashboard project → Settings → Environment Variables**:

```dotenv
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_BUCKET=barangaywatch-recordings
```

Keep the existing `DATABASE_URL`, session secret and Supabase values. Never put R2/Supabase administrative keys in firmware, browser code, Git, or chat. Firmware receives only a camera-specific token and short-lived URLs.

## 2. Configure R2 CORS for browser playback

Open **bucket → Settings → CORS policy**. The ready-to-paste policy is [r2-cors.json](r2-cors.json) for your production dashboard at `https://pob3-a.vercel.app`. Add any preview/custom origins you actually use. Local development may use the localhost origin below.

```json
[
  {
    "AllowedOrigins": ["https://pob3-a.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

CORS is required for the browser player. The ESP32 itself is not a browser and does not require a CORS policy for its signed `PUT` requests. Keep the bucket private; signed URLs use R2's S3 endpoint, not a public/custom bucket domain.

## 3. Prepare the database and API

Run `database/device_recordings.sql` in the **Supabase SQL Editor**. It creates the device token and pending upload tables, creates the recording table if needed, and adds provider/device ID columns without deleting old recordings. RLS is enabled; access happens through your existing server-side PostgreSQL connection and role checks. Do not add anonymous policies to expose these tables.

The server can also run this bundled schema on first authenticated recording request if the configured PostgreSQL account has DDL permission. Running the SQL explicitly makes setup errors easier to see.

Install and verify from the repository root:

```powershell
npm.cmd ci
npm.cmd run generate:schemas
node --test tests/device-recordings.test.js tests/mjpeg-avi.test.js tests/runtime-schemas.test.js
```

Optional deeper checks are `tests/recording-player.browser.cjs` (Playwright Core plus installed Microsoft Edge) and `tests/device-recordings.database.cjs` (PGlite). Both accept the installed dependency's module path as their first argument, so test tools can live in a temporary directory rather than in production dependencies. They use local fixtures and do not contact Supabase or R2.

Deploy the updated source to your existing Vercel project after setting the environment variables. Its build command remains `npm run vercel-build`. The video bytes bypass Vercel entirely; the API receives only JSON and reads a 224-byte AVI header when verifying the upload. Old Supabase/local MP4/WebM recordings remain supported.

## 4. Register your camera and generate a device token

Sign in as **Admin**. Under **Camera setup**, save an enabled camera with a name and its local stream URL, such as `http://192.168.1.6:81/stream`. Reserve that camera IP in the router if possible. If you do not know its IP yet, save the camera, then update its URL after flashing and reading Serial Monitor.

Open **Recording history → Camera upload access**, choose the camera, and press **Generate token**. Copy the displayed `bwcam_...` value. Only a SHA-256 hash is stored in the database. The raw token cannot be retrieved later; generating another replaces the old one. **Revoke token** disables device uploads. Disabling or archiving the camera also blocks new device requests.

## 5. Prepare the firmware

Use **Arduino IDE 2**, install **esp32 by Espressif Systems 3.3.12**, and install **ArduinoJson 7.4.3** using Library Manager. The supplied sketch compiled successfully with those versions for `esp32:esp32:esp32cam`: 1,323,793 bytes of application flash and 61,616 bytes of static RAM. These figures do not measure runtime TLS/SD memory or prove hardware reliability.

Open `ESP32/BarangayRecorder/BarangayRecorder.ino`. Copy `secrets.example.h` to **`secrets.h` in the same folder**, then edit:

```cpp
const char* WIFI_SSID = "your_2.4GHz_wifi";
const char* WIFI_PASSWORD = "your_wifi_password";
// Optional: used automatically when the primary Wi-Fi is unavailable.
#define FALLBACK_WIFI_SSID "your_phone_hotspot"
#define FALLBACK_WIFI_PASSWORD "your_hotspot_password"
const char* API_BASE_URL = "https://pob3-a.vercel.app";
const char* DEVICE_TOKEN = "bwcam_...token_from_the_admin_page...";
```

Use the canonical HTTPS Vercel/custom domain with no trailing slash. Device API routes must not be blocked by Vercel Deployment Protection. Keep certificate validation enabled; the sketch uses Espressif's built-in CA certificate bundle. Do not replace it with `setInsecure()`.

The primary Wi-Fi is tried first. If it cannot connect within roughly 15 seconds, the fallback Wi-Fi is tried. Leave both `FALLBACK_WIFI_*` values blank when no backup network is needed. A normal 2.4 GHz router or phone hotspot works; public Wi-Fi with a browser login page does not.

Select **AI Thinker ESP32-CAM**, enable PSRAM if that option is shown, and choose a partition scheme with enough application space (Huge APP / 3 MB). The camera pin mapping is for AI Thinker OV2640. This firmware replaces the current camera sketch; it is not an add-on to an already running sketch.

Insert a FAT32 microSD card. Use a stable regulated 5 V supply for the board; the USB-to-serial adapter's UART signals must use 3.3 V logic. For an adapter-based upload, connect GND to GND, adapter TX to U0R, adapter RX to U0T, and GPIO0 to GND during flashing. Select the correct COM port. After flashing, disconnect GPIO0 from GND and reset the board. An ESP32-CAM-MB base may handle the boot/reset sequence for you.

The sketch uses 1-bit SD mode, leaving the flash LED's GPIO4 out of SD data transfers. Do not add peripherals on the camera/SD pins without checking the mapping.

## 6. Check the first recording

Open **Serial Monitor at 115200 baud**. The camera needs Wi-Fi and NTP at boot for correct UTC timestamps and HTTPS validation. After time synchronization, expect:

```text
Local live stream: http://CAMERA_IP:81/stream
Clip queued for upload.
Recording uploaded and confirmed.
```

Update the saved camera stream URL to that IP. The local MJPEG stream is for viewers on the camera's Wi-Fi/LAN; it does not provide remote live viewing. Only the stored recordings are available remotely through R2. Browser local-network permission may be needed for the HTTPS dashboard to show a local HTTP stream. Do not expose port 81 directly to the internet.

Once a clip is confirmed, open **Recording history**, press **Load recordings**, and choose **Play**. The player downloads one clip (maximum 64 MiB) into browser memory and decodes one JPEG at a time. Download the original if needed. The recordings have no audio. Date filters use Philippine time; firmware/API device timestamps use UTC.

## 7. Test failure and recovery

- Disconnect Wi-Fi after the board has synchronized its clock. New clips should remain queued on SD. Reconnect; uploads should retry with backoff.
- Reset the camera after a clip is queued. The `.json` and `.avi` pair should upload after reboot. Retries reuse the recording ID, and R2 uploads are conditional to avoid overwriting the object. The API verifies size, MIME type and finalized AVI header before inserting the history row.
- A power failure during a recording may leave `.part` files. Power loss between closing the AVI and saving its metadata may leave an orphan `.avi`/`.tmp`. These files are preserved, not automatically uploaded. Recover them from the card on a PC. Corrupted `.json` metadata is renamed `.bad` so it does not block the rest of the queue.
- Successfully confirmed files are deleted from SD to free space. Pending recordings are never automatically deleted to make room. Recording pauses when less than approximately 65 MiB is available; it resumes when uploads free space.
- Recording and uploading run in separate tasks with an SD mutex. This reduces gaps, but does not guarantee gap-free footage: SD latency, TLS memory use, live viewers and Wi-Fi speed can reduce FPS or interrupt a clip. Validate several hours on the actual board before relying on it.
- Archive and restore a recording as Admin. Permanently deleting an archived R2 clip removes its R2 object; older Supabase clips continue using the existing Supabase path.

## API contract

Device requests authenticate with `Authorization: Bearer bwcam_...`. The camera ID is taken from the verified token, not from an arbitrary request field.

`POST /api/device/recordings/upload-url`:

```json
{
  "recordingId": "32_lowercase_hex_characters",
  "startedAt": "2026-11-14T00:00:00Z",
  "endedAt": "2026-11-14T00:01:00Z",
  "fileSize": 1234567
}
```

Response is either `{ "complete": true }`, `{ "uploaded": true }`, or a signed `uploadUrl` with required headers. For a new upload, send the closed SD file as the raw `PUT` body, `Content-Length` matching the declared size, `Content-Type: video/x-msvideo`, and `If-None-Match: *`. Signed URLs expire after 15 minutes. Request a fresh URL after a failed/expired upload; an already uploaded object can proceed directly to completion.

`POST /api/device/recordings/complete` accepts `{ "recordingId": "..." }` and is idempotent. `GET /api/recordings/:id/source` requires a dashboard login and returns a short-lived playback URL only for active recordings from enabled cameras. Signed URLs are bearer links until expiry; do not share them outside authorized viewers.

Pending upload rows are retained for retry/recovery. Monitor old pending rows and unconfirmed R2 objects when operating long term; this version does not schedule an automatic retention/cleanup job. Configuring R2 lifecycle deletion independently can remove video still listed in history, so choose a retention policy deliberately.

## References

- [Cloudflare R2 S3 credentials](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Espressif SD MMC](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/sdmmc.html)
- [AVI RIFF format](https://learn.microsoft.com/en-us/windows/win32/directshow/avi-riff-file-reference)
