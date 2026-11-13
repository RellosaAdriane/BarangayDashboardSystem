const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAvi, readClip } = require('../public/mjpeg-avi');
const fixture = require('./helpers/avi-fixture');

test('MJPEG AVI parser locates real JPEG frames and preserves timing and index padding', () => {
  const data = fixture();
  const parsed = parseAvi(data);
  assert.equal(parsed.frames.length, 3); assert.equal(parsed.frameSeconds, 0.2); assert.ok(Math.abs(parsed.duration - 0.6) < 0.001);
  for (const frame of parsed.frames) { assert.equal(data[frame.offset], 255); assert.equal(data[frame.offset + frame.size - 1], 217); }
  const prefixed = Buffer.concat([Buffer.alloc(13), data]);
  assert.equal(parseAvi(prefixed.subarray(13)).frames.length, 3);
});
test('AVI parser rejects unfinished, truncated, non-MJPEG and corrupt frame payloads', () => {
  for (const mutate of [
    (b) => b.subarray(0, b.length - 1),
    (b) => { b.writeUInt32LE(0, 48); return b; },
    (b) => { b.write('H264', 112); return b; },
    (b) => { b.writeUInt32LE(0xffffffff, 228); return b; },
    (b) => { b[232] = 0; return b; },
    (b) => { b.writeUInt32LE(99999, 64); return b; }
  ]) assert.throws(() => parseAvi(mutate(fixture())));
});
test('bounded playback download rejects expired links and oversized files', async () => {
  await assert.rejects(readClip(new Response('', { status: 403 })), /expired/);
  await assert.rejects(readClip(new Response(fixture()), 100), /64 MiB/);
  const parsed = await readClip(new Response(fixture())); assert.equal(parsed.frames.length, 3);
});
