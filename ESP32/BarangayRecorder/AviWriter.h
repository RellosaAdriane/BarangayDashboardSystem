#pragma once
#include <Arduino.h>
#include <FS.h>
#include <vector>

// One video stream, MJPG frames, RIFF AVI with an idx1 index.
// Caller holds the SD mutex while calling these methods.
class AviWriter {
  File file;
  struct Entry { uint32_t offset, length; };
  std::vector<Entry> entries;
  uint16_t width = 0, height = 0;
  uint32_t largest = 0;
  static void number(uint8_t* data, size_t offset, uint32_t value) {
    for (unsigned i = 0; i < 4; i++) data[offset + i] = (value >> (i * 8)) & 255;
  }
  bool writeNumber(uint32_t value) {
    uint8_t bytes[4]; number(bytes, 0, value); return file.write(bytes, 4) == 4;
  }
public:
  bool begin(fs::FS& fs, const String& path, uint16_t w, uint16_t h) {
    entries.clear(); entries.reserve(360); largest = 0; width = w; height = h;
    file = fs.open(path, FILE_WRITE);
    if (!file) return false;
    uint8_t header[224] = {};
    memcpy(header, "RIFF", 4); memcpy(header + 8, "AVI LIST", 8);
    number(header, 16, 192); memcpy(header + 20, "hdrlavih", 8); number(header, 28, 56);
    number(header, 44, 0x10); number(header, 56, 1); number(header, 64, w); number(header, 68, h);
    memcpy(header + 88, "LIST", 4); number(header, 92, 116); memcpy(header + 96, "strlstrh", 8);
    number(header, 104, 56); memcpy(header + 108, "vidsMJPG", 8);
    number(header, 128, 1); number(header, 148, 0xffffffff);
    header[160] = w & 255; header[161] = w >> 8; header[162] = h & 255; header[163] = h >> 8;
    memcpy(header + 164, "strf", 4); number(header, 168, 40); number(header, 172, 40);
    number(header, 176, w); number(header, 180, h); header[184] = 1; header[186] = 24;
    memcpy(header + 188, "MJPG", 4); number(header, 192, uint32_t(w) * h * 3);
    memcpy(header + 212, "LIST", 4); memcpy(header + 220, "movi", 4);
    return file.write(header, sizeof(header)) == sizeof(header);
  }
  bool frame(const uint8_t* data, size_t length) {
    if (!file || length < 4 || length > 256 * 1024 || entries.size() >= 600) return false;
    if (data[0] != 255 || data[1] != 216 || data[length - 2] != 255 || data[length - 1] != 217) return false;
    const uint32_t offset = file.position() - 220;
    if (file.write((const uint8_t*)"00dc", 4) != 4 || !writeNumber(length) || file.write(data, length) != length) return false;
    if ((length & 1) && file.write(uint8_t(0)) != 1) return false;
    entries.push_back({ offset, uint32_t(length) });
    if (length > largest) largest = length;
    return true;
  }
  uint32_t frames() const { return entries.size(); }
  uint32_t size() { return file ? file.size() : 0; }
  bool finish(uint32_t durationMs) {
    if (!file || entries.empty() || !durationMs) { close(); return false; }
    const uint32_t indexStart = file.position(), count = entries.size();
    bool ok = file.write((const uint8_t*)"idx1", 4) == 4 && writeNumber(count * 16);
    for (const Entry& e : entries) {
      ok = ok && file.write((const uint8_t*)"00dc", 4) == 4 && writeNumber(0x10) && writeNumber(e.offset) && writeNumber(e.length);
    }
    const uint32_t size = file.position();
    auto patch = [&](uint32_t offset, uint32_t value) { ok = file.seek(offset) && writeNumber(value) && ok; };
    const uint32_t usec = uint64_t(durationMs) * 1000 / count;
    patch(4, size - 8); patch(32, usec); patch(36, largest * 1000000ULL / usec);
    patch(48, count); patch(60, largest); patch(128, usec); patch(132, 1000000);
    patch(140, count); patch(144, largest); patch(216, indexStart - 220);
    file.flush(); close(); return ok;
  }
  void close() { if (file) file.close(); entries.clear(); }
};
