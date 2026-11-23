// AI Thinker ESP32-CAM / OV2640. Verified compile: ESP32 core 3.3.12, ArduinoJson 7.4.3.
// Records silent SVGA MJPEG AVI clips. The uploader reads closed clips from SD.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SD_MMC.h>
#include <esp_camera.h>
#include <esp_http_server.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <time.h>
#include "AviWriter.h"
#include "secrets.h"

// Existing secrets.h files stay compatible. Add these two optional macros when
// you want a backup Wi-Fi network.
#ifndef FALLBACK_WIFI_SSID
#define FALLBACK_WIFI_SSID ""
#endif
#ifndef FALLBACK_WIFI_PASSWORD
#define FALLBACK_WIFI_PASSWORD ""
#endif
#ifndef VERCEL_PROTECTION_BYPASS
#define VERCEL_PROTECTION_BYPASS ""
#endif

constexpr uint32_t CLIP_MS = 60000, FRAME_MS = 200, MAX_FILE_BYTES = 64 * 1024 * 1024;
constexpr uint32_t CLOUD_FACE_CHECK_MS = 8000, MAX_CLOUD_FRAME_BYTES = 1536 * 1024;
constexpr time_t MIN_VALID_EPOCH = 1735689600; // 2025-01-01 UTC
constexpr int FLASH_LED_PIN = 4;
constexpr int FLASH_INDICATOR_DUTY = 8; // very dim power indicator, 8-bit PWM
SemaphoreHandle_t sdMutex;
SemaphoreHandle_t httpsMutex;
AviWriter writer;
bool cameraReady = false;
bool sdReady = false;
bool streamStarted = false;
bool uploaderStarted = false;
bool ntpWaitLogged = false;
bool recordingClockWaitLogged = false;
uint32_t nextClipAt = 0;
void sdLock() { xSemaphoreTake(sdMutex, portMAX_DELAY); }
void sdUnlock() { xSemaphoreGive(sdMutex); }
void httpsLock() { xSemaphoreTake(httpsMutex, portMAX_DELAY); }
void httpsUnlock() { xSemaphoreGive(httpsMutex); }
String isoTime(time_t value) {
  struct tm time; gmtime_r(&value, &time); char buffer[24];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &time); return String(buffer);
}
String recordingId() {
  uint8_t random[16]; esp_fill_random(random, sizeof(random));
  char text[33]; for (unsigned i = 0; i < 16; i++) snprintf(text + i * 2, 3, "%02x", random[i]);
  return String(text);
}
void secureClient(WiFiClientSecure& client) {
  // ESP-IDF root certificate bundle: verifies both Vercel and R2 certificates.
  client.useBuiltinCACertBundle();
  client.setHandshakeTimeout(20);
}
bool joinWifi(const char* ssid, const char* password, uint32_t timeoutMs) {
  if (!ssid || !ssid[0]) return false;
  WiFi.disconnect(false, false);
  WiFi.begin(ssid, password);
  const uint32_t began = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - began < timeoutMs) delay(250);
  return WiFi.status() == WL_CONNECTED;
}
bool connectWifi(uint32_t timeoutMs = 8000) {
  if (WiFi.status() == WL_CONNECTED) return true;
  // Try the primary briefly, then fail over immediately to the configured backup.
  if (joinWifi(WIFI_SSID, WIFI_PASSWORD, timeoutMs)) {
    Serial.printf("Wi-Fi connected. Stream URL: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
    return true;
  }
  if (FALLBACK_WIFI_SSID[0]) {
    Serial.printf("Primary Wi-Fi unavailable after %u ms; trying fallback Wi-Fi.\n", unsigned(timeoutMs));
    if (joinWifi(FALLBACK_WIFI_SSID, FALLBACK_WIFI_PASSWORD, timeoutMs)) {
      Serial.printf("Fallback Wi-Fi connected. Stream URL: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
      return true;
    }
    Serial.println("Fallback Wi-Fi connection failed; will retry.");
    return false;
  }
  Serial.printf("Primary Wi-Fi connection failed after %u ms; no fallback Wi-Fi is configured.\n", unsigned(timeoutMs));
  return false;
}
bool postJson(const String& path, const String& body, JsonDocument& result, int* responseStatus = nullptr) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("API request skipped (%s): Wi-Fi is disconnected.\n", path.c_str());
    return false;
  }
  httpsLock();
  const size_t internalFreeBeforeTls = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  const size_t internalLargestBeforeTls = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
  const size_t psramFreeBeforeTls = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  WiFiClientSecure tls; secureClient(tls);
  HTTPClient http; http.setConnectTimeout(15000); http.setTimeout(30000);
  if (!http.begin(tls, String(API_BASE_URL) + path)) {
    Serial.printf("API request could not start (%s). Check API_BASE_URL.\n", path.c_str());
    httpsUnlock();
    return false;
  }
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  if (VERCEL_PROTECTION_BYPASS[0]) http.addHeader("x-vercel-protection-bypass", VERCEL_PROTECTION_BYPASS);
  http.addHeader("Content-Type", "application/json");
  const int status = http.POST(body);
  if (responseStatus) *responseStatus = status;
  // Deliberately do not log tokens, API bodies, or presigned URLs.
  bool ok = status >= 200 && status < 300;
  String responseBody = http.getString();
  if (ok) {
    DeserializationError error = deserializeJson(result, responseBody);
    ok = !error;
    if (!ok) Serial.printf("API response was not valid JSON (%s): %s\n", path.c_str(), error.c_str());
  } else {
    Serial.printf("API request failed (%s): HTTP %d, %s\n", path.c_str(), status,
                  status < 0 ? http.errorToString(status).c_str() : "server rejected request");
    if (status < 0) {
      char tlsError[128] = {};
      const int tlsErrorCode = tls.lastError(tlsError, sizeof(tlsError));
      Serial.printf("TLS memory at connect: internal=%u bytes, largest block=%u bytes, PSRAM=%u bytes; TLS error %d: %s\n",
                    unsigned(internalFreeBeforeTls), unsigned(internalLargestBeforeTls), unsigned(psramFreeBeforeTls),
                    tlsErrorCode, tlsError[0] ? tlsError : "none");
    }
    // Error responses are useful for setup diagnosis; truncate to avoid noisy logs.
    if (responseBody.length()) {
      if (responseBody.length() > 240) responseBody = responseBody.substring(0, 240);
      Serial.printf("API error response: %s\n", responseBody.c_str());
    }
  }
  http.end(); httpsUnlock(); return ok;
}
// HTTPClient reads bounded buffers from this stream. Lock only each SD read so
// network stalls never hold the SD mutex for the entire upload.
class SdUploadStream : public Stream {
  File file;
public:
  bool open(const String& path) { sdLock(); file = SD_MMC.open(path, FILE_READ); sdUnlock(); return bool(file); }
  void close() { sdLock(); if (file) file.close(); sdUnlock(); }
  int available() override { sdLock(); int n = file ? file.available() : 0; sdUnlock(); return n; }
  int read() override { sdLock(); int n = file.read(); sdUnlock(); return n; }
  int peek() override { sdLock(); int n = file.peek(); sdUnlock(); return n; }
  size_t readBytes(char* data, size_t length) override { sdLock(); size_t n = file.read((uint8_t*)data, length); sdUnlock(); return n; }
  size_t write(uint8_t) override { return 0; }
};
bool uploadFile(const String& path, const String& url, size_t size) {
  SdUploadStream stream;
  if (!stream.open(path)) {
    Serial.printf("Cannot open queued clip from SD: %s\n", path.c_str());
    return false;
  }
  if (!url.length()) {
    Serial.println("Upload URL is missing from the API response.");
    stream.close();
    return false;
  }
  httpsLock();
  WiFiClientSecure tls; secureClient(tls);
  HTTPClient http; http.setConnectTimeout(15000); http.setTimeout(60000);
  bool ok = http.begin(tls, url);
  if (ok) {
    http.addHeader("Content-Type", "video/x-msvideo");
    http.addHeader("If-None-Match", "*");
    const int status = http.sendRequest("PUT", &stream, size);
    // 412 can mean the same immutable recording was already uploaded.
    ok = (status >= 200 && status < 300) || status == 412;
    if (!ok) {
      Serial.printf("R2 upload failed: HTTP %d, %s\n", status,
                    status < 0 ? http.errorToString(status).c_str() : "storage rejected the clip");
      String responseBody = http.getString();
      if (responseBody.length()) {
        if (responseBody.length() > 240) responseBody = responseBody.substring(0, 240);
        Serial.printf("R2 error response: %s\n", responseBody.c_str());
      }
    }
  } else {
    Serial.println("Could not start HTTPS upload. Check NTP time, CA bundle, and signed URL.");
  }
  http.end(); httpsUnlock(); stream.close(); return ok;
}
String findPending() {
  String found;
  sdLock();
  File directory = SD_MMC.open("/clips");
  if (directory) {
    File entry = directory.openNextFile();
    while (entry) {
      String name = entry.name();
      if (!entry.isDirectory() && name.endsWith(".json")) { found = name.startsWith("/") ? name : "/clips/" + name; entry.close(); break; }
      entry.close(); entry = directory.openNextFile();
    }
    directory.close();
  }
  sdUnlock(); return found;
}
bool processPending(const String& metadataPath) {
  String body;
  sdLock(); File metadata = SD_MMC.open(metadataPath, FILE_READ);
  if (metadata) { body = metadata.readString(); metadata.close(); }
  sdUnlock();
  JsonDocument info;
  if (deserializeJson(info, body) || !info["recordingId"].is<String>() || info["recordingId"].as<String>().length() != 32) {
    sdLock(); SD_MMC.rename(metadataPath, metadataPath + ".bad"); sdUnlock();
    Serial.println("Invalid clip metadata preserved as .bad; skipping it."); return true;
  }
  const String id = info["recordingId"].as<String>();
  const String filePath = "/clips/" + id + ".avi";
  Serial.printf("Uploading queued clip %s (start=%s, end=%s, size=%u bytes)...\n", id.c_str(),
                info["startedAt"].as<String>().c_str(), info["endedAt"].as<String>().c_str(),
                unsigned(info["fileSize"].as<size_t>()));
  JsonDocument response;
  int uploadUrlStatus = 0;
  if (!postJson("/api/device/recordings/upload-url", body, response, &uploadUrlStatus)) {
    // A permanent validation error would otherwise keep this first file at the
    // head of the queue forever. Preserve it for recovery and move on.
    if (uploadUrlStatus == 400) {
      sdLock(); SD_MMC.rename(metadataPath, metadataPath + ".bad"); sdUnlock();
      Serial.println("API rejected this clip's metadata (HTTP 400); metadata renamed .bad and AVI retained on SD.");
      return true;
    }
    return false;
  }
  if (!response["complete"].as<bool>()) {
    if (!response["uploaded"].as<bool>()) {
      if (!response["uploadUrl"].is<String>()) {
        Serial.println("Upload URL API response is missing uploadUrl.");
        return false;
      }
      if (!uploadFile(filePath, response["uploadUrl"].as<String>(), info["fileSize"].as<size_t>())) return false;
    }
    JsonDocument complete; String request = "{\"recordingId\":\"" + id + "\"}";
    if (!postJson("/api/device/recordings/complete", request, complete)) return false;
  }
  // Remove only after the server confirms the database record. Pending clips
  // survive power loss and Wi-Fi failures; uploaded files are not kept locally.
  sdLock(); bool removed = SD_MMC.remove(filePath);
  if (removed || !SD_MMC.exists(filePath)) SD_MMC.remove(metadataPath);
  sdUnlock();
  Serial.println("Recording uploaded and confirmed."); return true;
}
void uploader(void*) {
  uint32_t retryDelay = 3000;
  for (;;) {
    if (!connectWifi()) { vTaskDelay(pdMS_TO_TICKS(10000)); continue; }
    // HTTPS certificate checks need a valid clock. NTP may not have completed
    // during setup, so keep waiting here instead of repeatedly attempting uploads.
    if (time(nullptr) < MIN_VALID_EPOCH) {
      if (!ntpWaitLogged) {
        Serial.println("NTP time not ready; uploader is waiting before clip uploads.");
        ntpWaitLogged = true;
      }
      vTaskDelay(pdMS_TO_TICKS(5000));
      continue;
    }
    ntpWaitLogged = false;
    String pending = findPending();
    bool ok = pending.isEmpty() || processPending(pending);
    retryDelay = ok ? 3000 : min(uint32_t(60000), retryDelay * 2);
    vTaskDelay(pdMS_TO_TICKS(retryDelay));
  }
}
bool postFaceFrame(camera_fb_t* frame) {
  if (!frame || frame->format != PIXFORMAT_JPEG || frame->len > MAX_CLOUD_FRAME_BYTES) return false;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cloud face check failed: ESP32 is not connected to Wi-Fi.");
    return false;
  }
  const String baseUrl = API_BASE_URL;
  const int schemeEnd = baseUrl.indexOf("://");
  if (schemeEnd < 0) {
    Serial.println("Cloud face check failed: API_BASE_URL must use HTTPS.");
    return false;
  }
  const int hostStart = schemeEnd + 3;
  const int hostEnd = baseUrl.indexOf('/', hostStart);
  const String host = hostEnd < 0 ? baseUrl.substring(hostStart) : baseUrl.substring(hostStart, hostEnd);
  IPAddress resolvedAddress;
  if (WiFi.hostByName(host.c_str(), resolvedAddress) != 1) {
    Serial.printf("Cloud face check failed: DNS could not resolve the Vercel host. Wi-Fi RSSI=%d dBm.\n", WiFi.RSSI());
    return false;
  }
  const size_t internalFreeBeforeTls = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  const size_t internalLargestBeforeTls = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
  const size_t psramFreeBeforeTls = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  WiFiClientSecure tls; secureClient(tls);
  HTTPClient http; http.setConnectTimeout(15000); http.setTimeout(45000);
  if (!http.begin(tls, baseUrl + "/api/device/face-frame")) {
    Serial.printf("Cloud face check failed: HTTPS request setup failed for %s.\n", host.c_str());
    return false;
  }
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  if (VERCEL_PROTECTION_BYPASS[0]) http.addHeader("x-vercel-protection-bypass", VERCEL_PROTECTION_BYPASS);
  http.addHeader("Content-Type", "image/jpeg");
  const int status = http.POST(frame->buf, frame->len);
  if (status >= 200 && status < 300) {
    JsonDocument result; const String response = http.getString();
    if (!deserializeJson(result, response)) {
      Serial.printf("Cloud face check: %u face(s), %u unknown; %s.\n",
                    result["faces"].as<unsigned>(), result["unknown"].as<unsigned>(),
                    result["emailSent"].as<bool>() ? "email sent" : result["alertCreated"].as<bool>() ? "alert saved" : "no new alert");
    }
    http.end(); return true;
  }
  char tlsError[128] = {};
  const int tlsErrorCode = tls.lastError(tlsError, sizeof(tlsError));
  Serial.printf("Cloud face check failed: HTTP %d, %s; DNS resolved, Wi-Fi RSSI=%d dBm, TLS error %d: %s; memory internal=%u bytes (largest block=%u), PSRAM=%u bytes.\n", status,
                status < 0 ? http.errorToString(status).c_str() : "server rejected the frame",
                WiFi.RSSI(), tlsErrorCode, tlsError[0] ? tlsError : "none",
                unsigned(internalFreeBeforeTls), unsigned(internalLargestBeforeTls), unsigned(psramFreeBeforeTls));
  http.end(); return false;
}
void cloudFaceMonitor(void*) {
  for (;;) {
    if (WiFi.status() != WL_CONNECTED || time(nullptr) < MIN_VALID_EPOCH) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    // Serialize HTTPS use with the SD clip uploader. The ESP32-CAM has limited
    // heap/socket resources; simultaneous TLS handshakes can be refused by the
    // network stack even when either request succeeds on its own.
    httpsLock();
    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame) Serial.println("Cloud face check skipped: camera frame unavailable.");
    else {
      if (frame->format != PIXFORMAT_JPEG || frame->len > MAX_CLOUD_FRAME_BYTES)
        Serial.printf("Cloud face check skipped: JPEG frame is %u bytes (limit %u).\n", unsigned(frame->len), unsigned(MAX_CLOUD_FRAME_BYTES));
      else postFaceFrame(frame);
      esp_camera_fb_return(frame);
    }
    httpsUnlock();
    vTaskDelay(pdMS_TO_TICKS(CLOUD_FACE_CHECK_MS));
  }
}
void setCameraFlashIndicator(bool on) {
  pinMode(FLASH_LED_PIN, OUTPUT);
  analogWrite(FLASH_LED_PIN, on ? FLASH_INDICATOR_DUTY : 0);
}
bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = 5; c.pin_d1 = 18; c.pin_d2 = 19; c.pin_d3 = 21;
  c.pin_d4 = 36; c.pin_d5 = 39; c.pin_d6 = 34; c.pin_d7 = 35;
  c.pin_xclk = 0; c.pin_pclk = 22; c.pin_vsync = 25; c.pin_href = 23;
  c.pin_sccb_sda = 26; c.pin_sccb_scl = 27; c.pin_pwdn = 32; c.pin_reset = -1;
  c.xclk_freq_hz = 20000000; c.pixel_format = PIXFORMAT_JPEG; c.frame_size = FRAMESIZE_SVGA;
  // SVGA gives browser face detection more facial pixels. Quality 12 balances
  // detail and MJPEG bandwidth; lower JPEG values create larger, clearer frames.
  c.jpeg_quality = 12; c.fb_count = 2; c.fb_location = CAMERA_FB_IN_PSRAM; c.grab_mode = CAMERA_GRAB_LATEST;
  if (esp_camera_init(&c) != ESP_OK) return false;
  // Keep automatic exposure/gain moderate to avoid washed-out frames.
  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_brightness(sensor, 0);
    sensor->set_ae_level(sensor, 0);
    sensor->set_gainceiling(sensor, GAINCEILING_8X);
  }
  return true;
}
esp_err_t liveStream(httpd_req_t* request) {
  httpd_resp_set_type(request, "multipart/x-mixed-replace;boundary=frame");
  httpd_resp_set_hdr(request, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  for (;;) {
    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame) return ESP_FAIL;
    char header[96]; const int length = snprintf(header, sizeof(header), "\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", unsigned(frame->len));
    esp_err_t result = httpd_resp_send_chunk(request, header, length);
    if (result == ESP_OK) result = httpd_resp_send_chunk(request, (const char*)frame->buf, frame->len);
    esp_camera_fb_return(frame);
    if (result != ESP_OK) return result;
    vTaskDelay(pdMS_TO_TICKS(FRAME_MS));
  }
}
void startLocalStream() {
  httpd_handle_t server = nullptr;
  httpd_config_t config = HTTPD_DEFAULT_CONFIG(); config.server_port = 81; config.stack_size = 8192;
  if (httpd_start(&server, &config) == ESP_OK) {
    httpd_uri_t route = {}; route.uri = "/stream"; route.method = HTTP_GET; route.handler = liveStream;
    httpd_register_uri_handler(server, &route);
    streamStarted = true;
    Serial.printf("Local live stream: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
  }
}
void recoverIncomplete() {
  // .part/.tmp files are deliberately never uploaded: their AVI header or
  // metadata may be incomplete. Preserve them for manual recovery on a PC.
  sdLock(); File directory = SD_MMC.open("/clips"); size_t count = 0;
  if (directory) { File entry = directory.openNextFile(); while (entry) { if (String(entry.name()).endsWith(".part")) count++; entry.close(); entry = directory.openNextFile(); } directory.close(); }
  sdUnlock(); if (count) Serial.printf("%u incomplete clips preserved on SD for manual recovery.\n", unsigned(count));
}
void setup() {
  Serial.begin(115200); delay(1000);
  Serial.println("Firmware build: SD DMA chunk writer 512 bytes.");
  if (!psramFound()) { Serial.println("PSRAM required. Select AI Thinker ESP32-CAM with PSRAM enabled."); return; }
  sdMutex = xSemaphoreCreateMutex(); if (!sdMutex) return;
  httpsMutex = xSemaphoreCreateMutex(); if (!httpsMutex) return;
  WiFi.mode(WIFI_STA); WiFi.setSleep(false);
  Serial.println("Connecting to Wi-Fi...");
  if (!connectWifi()) Serial.println("Wi-Fi unavailable; reconnect will be retried in background.");

  if (!initCamera()) { Serial.println("Camera initialization failed."); return; }
  setCameraFlashIndicator(true); // Very dim flash LED indicates that the camera is ready.

  // Start the live camera stream independently of SD card availability.
  if (WiFi.status() == WL_CONNECTED) startLocalStream();
  cameraReady = true;

  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.println("Waiting for NTP time before cloud checks and clip uploads...");
  const uint32_t ntpStarted = millis();
  while (time(nullptr) < MIN_VALID_EPOCH && millis() - ntpStarted < 15000) delay(500);
  if (time(nullptr) < MIN_VALID_EPOCH) Serial.println("NTP time not ready; cloud checks and uploads will retry.");
  if (xTaskCreatePinnedToCore(cloudFaceMonitor, "cloud-face-check", 12288, nullptr, 1, nullptr, 0) != pdPASS) {
    Serial.println("Cannot start cloud face monitor; local stream remains available.");
  } else Serial.println("Cloud face monitoring started. Snapshot checks run without an open dashboard.");

  // SD is optional for live streaming. Recording and clip upload need it.
  // 1-bit SD mode avoids GPIO4 (flash LED) and GPIO12 boot conflicts.
  if (!SD_MMC.begin("/sdcard", true) || SD_MMC.cardType() == CARD_NONE) {
    Serial.println("No usable FAT32 microSD; Wi-Fi camera stream remains available, recording disabled.");
    return;
  }
  sdReady = true;
  SD_MMC.mkdir("/clips"); recoverIncomplete();
  uploaderStarted = true; // Hand Wi-Fi reconnect ownership to the uploader before it can run.
  if (xTaskCreatePinnedToCore(uploader, "clip-upload", 16384, nullptr, 1, nullptr, 0) != pdPASS) {
    uploaderStarted = false;
    Serial.println("Cannot start uploader; live stream remains available.");
  } else Serial.println("Clip uploader started.");
}
void loop() {
  if (!cameraReady) { delay(1000); return; }
  // The uploader task owns reconnects once it starts. Reconnecting from loop()
  // at the same time caused overlapping WiFi.begin()/disconnect() calls.
  if (!uploaderStarted && WiFi.status() != WL_CONNECTED) connectWifi(5000);
  if (WiFi.status() == WL_CONNECTED && !streamStarted) startLocalStream();
  if (!sdReady) { delay(1000); return; }
  // Do not let a first NTP sync change the clock halfway through a clip. The
  // API requires a sane UTC start/end pair with a duration of 1 to 120 seconds.
  if (time(nullptr) < MIN_VALID_EPOCH) {
    if (!recordingClockWaitLogged) {
      Serial.println("Waiting for valid NTP time before recording clips.");
      recordingClockWaitLogged = true;
    }
    delay(1000);
    return;
  }
  recordingClockWaitLogged = false;
  if (int32_t(millis() - nextClipAt) < 0) { delay(100); return; }
  // Never delete pending recordings to make room. Pausez  until uploads free SD space.
  sdLock(); uint64_t freeBytes = SD_MMC.totalBytes() - SD_MMC.usedBytes(); sdUnlock();
  if (freeBytes < MAX_FILE_BYTES + 1048576) { Serial.println("SD nearly full: recording paused; pending uploads retained."); nextClipAt = millis() + 10000; return; }
  const String id = recordingId(), part = "/clips/" + id + ".part", avi = "/clips/" + id + ".avi";
  const time_t started = time(nullptr); const uint32_t began = millis();
  sdLock(); bool ok = writer.begin(SD_MMC, part, 640, 480); sdUnlock();
  if (!ok) { nextClipAt = millis() + 5000; return; }
  uint32_t nextFrame = began;
  while (millis() - began < CLIP_MS) {
    if (int32_t(millis() - nextFrame) < 0) { delay(1); continue; }
    nextFrame = millis() + FRAME_MS;
    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame) { ok = false; break; }
    sdLock(); ok = writer.frame(frame->buf, frame->len) && writer.size() < MAX_FILE_BYTES - 16384; sdUnlock();
    esp_camera_fb_return(frame);
    if (!ok) break;
  }
  const uint32_t duration = millis() - began; const time_t ended = time(nullptr);
  sdLock();
  ok = ok && duration >= 1000;
  if (ok) ok = writer.finish(duration); else writer.close();
  if (ok) ok = SD_MMC.rename(part, avi);
  if (ok) {
    File file = SD_MMC.open(avi, FILE_READ); const size_t size = file.size(); file.close();
    JsonDocument info; info["recordingId"] = id; info["startedAt"] = isoTime(started); info["endedAt"] = isoTime(ended); info["fileSize"] = size;
    const String tmp = "/clips/" + id + ".tmp", target = "/clips/" + id + ".json";
    File metadata = SD_MMC.open(tmp, FILE_WRITE);
    if (metadata) { ok = serializeJson(info, metadata) > 0; metadata.flush(); metadata.close(); if (ok) ok = SD_MMC.rename(tmp, target); }
    else ok = false;
  }
  sdUnlock();
  Serial.println(ok ? "Clip queued for upload." : "Recording interrupted; partial file retained for recovery.");
  if (!ok) nextClipAt = millis() + 5000;
}
