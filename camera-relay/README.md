# Secure ESP32-CAM relay

The deployed dashboard uses HTTPS, while `http://192.168.1.6:81/stream` is an HTTP address on the local Wi-Fi. Browsers block embedding this private-IP stream inside an HTTPS page. Vercel also cannot route to a camera inside the home/barangay network. This small relay must run on an always-on computer on the same Wi-Fi as the camera, then be exposed through a public HTTPS tunnel.

The relay only serves URLs signed by the dashboard API and only connects to hosts listed in `CAMERA_ALLOWED_HOSTS`.

## Run on a computer on the camera's Wi-Fi

Install Node.js 20 or newer, open PowerShell in this directory, then set the required environment values and start the service:

```powershell
$env:PORT = '8787'
$env:CAMERA_RELAY_SECRET = '<same random secret configured in Vercel>'
$env:CAMERA_ALLOWED_HOSTS = '192.168.1.6'
node .\server.js
```

Keep this process running. On that computer, `http://localhost:8787/health` should return `{"ok":true,...}`.

## Expose it over HTTPS

Create a Cloudflare Tunnel that forwards a public HTTPS hostname to `http://localhost:8787`. The tunnel must run on the same computer as the relay. Keep the hostname and tunnel running continuously for Captain and Tanod access.

## Configure Vercel

Set these Production environment variables, then redeploy:

- `CAMERA_RELAY_BASE_URL`: the tunnel's HTTPS origin, with no path (for example `https://camera-relay.example.com`)
- `CAMERA_RELAY_SECRET`: the exact same random secret used by the local relay; use at least 32 random bytes

To generate a secret in PowerShell:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Do not expose port 81 of the ESP32-CAM directly to the public internet. The dashboard API signs short-lived relay URLs; the relay verifies those signatures before proxying the stream.
