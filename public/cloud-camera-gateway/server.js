
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const CAMERA_TOKEN = process.env.CAMERA_TOKEN;
const VIEWER_TOKEN = process.env.VIEWER_TOKEN;

if (!CAMERA_TOKEN || !VIEWER_TOKEN) {
  console.error("Missing CAMERA_TOKEN or VIEWER_TOKEN environment variable.");
  process.exit(1);
}

let latestFrame = null;
let lastFrameAt = null;
let cameraConnected = false;

const viewers = new Set();

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024
});

function rejectUpgrade(socket, status, message) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
    "Connection: close\r\n\r\n"
  );
  socket.destroy();
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");

  if (url.pathname !== "/camera") {
    return rejectUpgrade(socket, 404, "Not Found");
  }

  if (url.searchParams.get("token") !== CAMERA_TOKEN) {
    return rejectUpgrade(socket, 401, "Unauthorized");
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  cameraConnected = true;
  console.log("ESP32-CAM connected.");

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;

    const frame = Buffer.from(data);

    // Check JPEG start and end markers.
    if (
      frame.length < 4 ||
      frame[0] !== 0xff ||
      frame[1] !== 0xd8 ||
      frame[frame.length - 2] !== 0xff ||
      frame[frame.length - 1] !== 0xd9
    ) {
      return;
    }

    latestFrame = frame;
    lastFrameAt = new Date().toISOString();

    const header = Buffer.from(
      "--frame\r\n" +
      "Content-Type: image/jpeg\r\n" +
      `Content-Length: ${frame.length}\r\n\r\n`
    );

    const ending = Buffer.from("\r\n");

    for (const viewer of viewers) {
      if (!viewer.destroyed) {
        viewer.write(header);
        viewer.write(frame);
        viewer.write(ending);
      }
    }
  });

  ws.on("close", () => {
    cameraConnected = false;
    console.log("ESP32-CAM disconnected.");
  });

  ws.on("error", (error) => {
    console.error("Camera WebSocket error:", error.message);
  });
});

function authorizeViewer(req, res, next) {
  if (req.query.token !== VIEWER_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  next();
}

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    cameraConnected,
    lastFrameAt
  });
});

app.get("/live", authorizeViewer, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Connection": "keep-alive",
    "Pragma": "no-cache"
  });

  viewers.add(res);

  if (latestFrame) {
    res.write(
      "--frame\r\n" +
      "Content-Type: image/jpeg\r\n" +
      `Content-Length: ${latestFrame.length}\r\n\r\n`
    );
    res.write(latestFrame);
    res.write("\r\n");
  }

  req.on("close", () => {
    viewers.delete(res);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BarangayWatch Camera Gateway listening on port ${PORT}`);
});
