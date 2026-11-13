// AI Thinker ESP32-CAM / OV2640. Verified compile: ESP32 core 3.3.12, ArduinoJson 7.4.3.
// Records silent QVGA MJPEG AVI clips. The uploader reads closed clips from SD.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SD_MMC.h>
#include <esp_camera.h>
#include <esp_http_server.h>
#include <esp_system.h>
#include <time.h>
#include "AviWriter.h"
#include "secrets.h"

constexpr uint32_t CLIP_MS = 60000, FRAME_MS = 200, MAX_FILE_BYTES = 64 * 1024 * 1024;
SemaphoreHandle_t sdMutex;
AviWriter writer;
bool cameraReady = false;
uint32_t nextClipAt = 0;
void sdLock() { xSemaphoreTake(sdMutex, portMAX_DELAY); }
void sdUnlock() { xSemaphoreGive(sdMutex); }
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
bool postJson(const String& path, const String& body, JsonDocument& result) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure tls; secureClient(tls);
  HTTPClient http; http.setConnectTimeout(15000); http.setTimeout(30000);
  if (!http.begin(tls, String(API_BASE_URL) + path)) return false;
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  const int status = http.POST(body);
  // Deliberately do not log tokens, API bodies, or presigned URLs.
  bool ok = status >= 200 && status < 300;
  if (ok) ok = !deserializeJson(result, http.getString());
  if (!ok) Serial.printf("API request failed: %d\n", status);
  http.end(); return ok;
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
  if (!stream.open(path)) return false;
  WiFiClientSecure tls; secureClient(tls);
  HTTPClient http; http.setConnectTimeout(15000); http.setTimeout(60000);
  bool ok = http.begin(tls, url);
  if (ok) {
    http.addHeader("Content-Type", "video/x-msvideo");
    http.addHeader("If-None-Match", "*");
    const int status = http.sendRequest("PUT", &stream, size);
    // 412 can mean the same immutable recording was already uploaded.
    ok = (status >= 200 && status < 300) || status == 412;
    if (!ok) Serial.printf("R2 upload failed: %d\n", status);
  }
  http.end(); stream.close(); return ok;
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
  JsonDocument response;
  if (!postJson("/api/device/recordings/upload-url", body, response)) return false;
  if (!response["complete"].as<bool>()) {
    if (!response["uploaded"].as<bool>()) {
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
    if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); vTaskDelay(pdMS_TO_TICKS(10000)); continue; }
    String pending = findPending();
    bool ok = pending.isEmpty() || processPending(pending);
    retryDelay = ok ? 3000 : min(uint32_t(60000), retryDelay * 2);
    vTaskDelay(pdMS_TO_TICKS(retryDelay));
  }
}
bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = 5; c.pin_d1 = 18; c.pin_d2 = 19; c.pin_d3 = 21;
  c.pin_d4 = 36; c.pin_d5 = 39; c.pin_d6 = 34; c.pin_d7 = 35;
  c.pin_xclk = 0; c.pin_pclk = 22; c.pin_vsync = 25; c.pin_href = 23;
  c.pin_sccb_sda = 26; c.pin_sccb_scl = 27; c.pin_pwdn = 32; c.pin_reset = -1;
  c.xclk_freq_hz = 20000000; c.pixel_format = PIXFORMAT_JPEG; c.frame_size = FRAMESIZE_QVGA;
  c.jpeg_quality = 14; c.fb_count = 2; c.fb_location = CAMERA_FB_IN_PSRAM; c.grab_mode = CAMERA_GRAB_LATEST;
  return esp_camera_init(&c) == ESP_OK;
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
  if (!psramFound()) { Serial.println("PSRAM required. Select AI Thinker ESP32-CAM with PSRAM enabled."); return; }
  sdMutex = xSemaphoreCreateMutex(); if (!sdMutex) return;
  // 1-bit SD mode avoids GPIO4 (flash LED) and GPIO12 boot conflicts.
  if (!SD_MMC.begin("/sdcard", true) || SD_MMC.cardType() == CARD_NONE) { Serial.println("Insert a FAT32 microSD card and restart."); return; }
  SD_MMC.mkdir("/clips"); recoverIncomplete();
  if (!initCamera()) { Serial.println("Camera initialization failed."); return; }
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  // Wait for trustworthy UTC timestamps and certificate validity checks.
  Serial.println("Waiting for Wi-Fi and NTP time…");
  while (WiFi.status() != WL_CONNECTED || time(nullptr) < 1735689600) { delay(500); }
  startLocalStream();
  if (xTaskCreatePinnedToCore(uploader, "clip-upload", 16384, nullptr, 1, nullptr, 0) != pdPASS) { Serial.println("Cannot start uploader."); return; }
  cameraReady = true;
}
void loop() {
  if (!cameraReady) { delay(1000); return; }
  if (int32_t(millis() - nextClipAt) < 0) { delay(100); return; }
  // Never delete pending recordings to make room. Pause until uploads free SD space.
  sdLock(); uint64_t freeBytes = SD_MMC.totalBytes() - SD_MMC.usedBytes(); sdUnlock();
  if (freeBytes < MAX_FILE_BYTES + 1048576) { Serial.println("SD nearly full: recording paused; pending uploads retained."); nextClipAt = millis() + 10000; return; }
  const String id = recordingId(), part = "/clips/" + id + ".part", avi = "/clips/" + id + ".avi";
  const time_t started = time(nullptr); const uint32_t began = millis();
  sdLock(); bool ok = writer.begin(SD_MMC, part, 320, 240); sdUnlock();
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
