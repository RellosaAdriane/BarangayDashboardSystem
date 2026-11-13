require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const createStorage = require('../r2-storage');
const fixture = require('../tests/helpers/avi-fixture');

(async () => {
  const storage = createStorage();
  const data = fixture();
  const key = `_checks/${crypto.randomUUID()}.avi`;
  let uploaded = false;
  try {
    const url = await storage.uploadUrl(key, data.length);
    const put = () => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'video/x-msvideo', 'Content-Length': String(data.length), 'If-None-Match': '*' }, body: data, signal: AbortSignal.timeout(30000) });
    const response = await put();
    console.log('Signed AVI upload: HTTP', response.status);
    if (!response.ok) throw new Error('Signed upload rejected');
    uploaded = true;
    const retry = await put();
    console.log('Overwrite protection: HTTP', retry.status);
    if (retry.status !== 412) throw new Error('Expected immutable upload protection');
    const head = await storage.head(key);
    if (Number(head.ContentLength) !== data.length || head.ContentType !== 'video/x-msvideo') throw new Error('Object metadata mismatch');
    const prefix = await storage.header(key);
    if (!prefix.equals(data.subarray(0, 224))) throw new Error('AVI header mismatch');
    const download = await fetch(await storage.videoUrl(key), { signal: AbortSignal.timeout(30000) });
    if (!download.ok || !Buffer.from(await download.arrayBuffer()).equals(data)) throw new Error('Playback download mismatch');
    console.log('R2 size, MIME type, AVI header and signed playback download: verified');
    const origin = process.argv[2];
    if (origin) {
      const cors = await fetch(await storage.videoUrl(key), { headers: { Origin: new URL(origin).origin }, signal: AbortSignal.timeout(30000) });
      console.log('Browser CORS allowed origin:', cors.headers.get('access-control-allow-origin') || '(missing)');
      await cors.body?.cancel();
    }
  } finally {
    if (uploaded) { await storage.remove(key); console.log('Temporary test recording deleted.'); }
  }
})().catch((error) => { console.error('R2 upload check failed:', error.code || error.name); process.exitCode = 1; });
