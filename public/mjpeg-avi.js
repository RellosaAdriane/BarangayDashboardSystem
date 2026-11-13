/* Silent MJPEG-in-AVI playback. JPEG frames are decoded by the browser. */
(function (root) {
  'use strict';
  function parseAvi(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fourcc = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (bytes.length < 224 || fourcc(0) !== 'RIFF' || fourcc(8) !== 'AVI ' || view.getUint32(4, true) + 8 !== bytes.length) throw new Error('Incomplete or invalid AVI file.');
    let microseconds = 0, width = 0, height = 0, mjpeg = false, declaredFrames = 0;
    const frames = [];
    function walk(start, end, inMovie = false, depth = 0) {
      if (depth > 8) throw new Error('Invalid AVI nesting.');
      for (let offset = start; offset + 8 <= end;) {
        const type = fourcc(offset), size = view.getUint32(offset + 4, true), data = offset + 8;
        if (size > end - data) throw new Error('Truncated AVI chunk.');
        if (type === 'LIST') {
          if (size < 4) throw new Error('Invalid AVI list.');
          walk(data + 4, data + size, inMovie || fourcc(data) === 'movi', depth + 1);
        } else if (type === 'avih' && size >= 56) {
          microseconds = view.getUint32(data, true);
          declaredFrames = view.getUint32(data + 16, true);
          width = view.getUint32(data + 32, true); height = view.getUint32(data + 36, true);
        } else if (type === 'strh' && size >= 8 && fourcc(data) === 'vids') {
          mjpeg = fourcc(data + 4) === 'MJPG';
        } else if (inMovie && /^00d[bc]$/.test(type)) {
          if (size < 4 || size > 2 * 1024 * 1024 || bytes[data] !== 255 || bytes[data + 1] !== 216 || bytes[data + size - 2] !== 255 || bytes[data + size - 1] !== 217) throw new Error('Invalid JPEG frame.');
          frames.push({ offset: data, size });
          if (frames.length > 6000) throw new Error('Recording contains too many frames.');
        }
        offset = data + size + (size & 1);
        if (offset > end) throw new Error('Invalid AVI padding.');
      }
    }
    walk(12, bytes.length);
    if (!mjpeg || !frames.length || declaredFrames !== frames.length || microseconds < 10000 || microseconds > 10000000 || !width || !height || width > 1920 || height > 1080) throw new Error('Unsupported AVI. Use MJPEG clips from the camera firmware.');
    return { bytes, frames, width, height, frameSeconds: microseconds / 1000000, duration: frames.length * microseconds / 1000000 };
  }
  async function readClip(response, maxBytes = 64 * 1024 * 1024) {
    if (!response.ok) throw new Error('Video link expired or unavailable. Close and reopen the recording.');
    if (Number(response.headers.get('Content-Length')) > maxBytes) throw new Error('Recording exceeds the 64 MiB playback limit.');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Recording exceeds the 64 MiB playback limit.'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseAvi(bytes);
  }
  root.MjpegAvi = { parseAvi, readClip };
  if (typeof module !== 'undefined') module.exports = root.MjpegAvi;
})(typeof window === 'undefined' ? globalThis : window);
