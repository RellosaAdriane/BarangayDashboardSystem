# Barangay Monitoring Dashboard (VS Code)

## Project structure

```text
barangay-dashboard-vscode/
├── public/
│   ├── index.html
│   ├── style.css
│   └── script.js
├── server.js
├── package.json
└── README.md
```

## Run in VS Code

1. Extract this ZIP file.
2. Open the extracted `barangay-dashboard-vscode` folder in VS Code.
3. Open **Terminal → New Terminal**.
4. Run:

   ```bash
   npm install
   npm start
   ```

5. Open `http://localhost:3000` in your browser.
6. Test the API at `http://localhost:3000/api/health`.

## API routes included

- `GET /api/health` — confirms the server is running.
- `GET /api/incidents` — returns incident records.
- `POST /api/incidents` — creates an incident. Example JSON:

  ```json
  {
    "type": "Possible Intruder",
    "note": "Motion reported near the front gate",
    "camera": "ESP32-CAM 01"
  }
  ```
- `GET /api/faces/recognize` — captures an image from the configured ESP32-CAM capture endpoint and returns face boxes and CompreFace matches.

## Face tracking setup

Set these values in the local `.env` file (it is excluded from Git):

```env
COMPREFACE_URL=http://localhost:8000
COMPREFACE_API_KEY=your-recognition-service-api-key
ESP32_CAPTURE_URL=http://your-camera-address/capture
COMPREFACE_DET_PROB_THRESHOLD=0.5
COMPREFACE_RECOGNITION_THRESHOLD=0.8
```

`ESP32_CAPTURE_URL` must return a still JPEG image; it can be different from the stream URL entered in the dashboard. Connect the camera in the dashboard to start automatic face checks. Recognized matches are outlined in green; faces without a sufficiently strong match are outlined in yellow and labeled “Unfamiliar.” Boxes also turn yellow while a new recognition check is running. Keep the API key on the server and never put it in browser code.

`COMPREFACE_DET_PROB_THRESHOLD` controls how confident CompreFace must be that a region is a face. It defaults to `0.5`; lower values can help with dim or angled faces but may add false detections. Restart the Node.js server after changing `.env`.

`COMPREFACE_RECOGNITION_THRESHOLD` controls the minimum similarity required to use a CompreFace subject name. It defaults to `0.8` (80%); lower-scoring matches are shown as “Unfamiliar” without a name or percentage. Increase it to reduce false name matches, or lower it if enrolled people are often marked unfamiliar. Restart the Node.js server after changing `.env`.

## Important limitations

- The Express server currently stores incidents in memory. Data is lost when the server restarts. Add MySQL or SQLite for persistent records.
- “Test alert” is a manual demo. Real alerts require your Arduino/ESP32 firmware to send an authenticated HTTP request to the API.
- The camera URL input is a browser preview, not a video proxy. Some ESP32 camera endpoints may not render in an `<img>` element. Use the correct stream endpoint and configure CORS/proxying if required.
- Face recognition requires the ESP32 capture endpoint and CompreFace service to be reachable from the Node.js server.
- This starter does not include login, user roles, HTTPS, or API authentication. Add these before using it with real barangay/security data.
- `localhost` is only the current computer. For phone/LAN access, use the computer's LAN IP and allow Node.js through the firewall. Do not expose this security dashboard publicly without authentication and HTTPS.
