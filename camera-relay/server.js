'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const port = Number(process.env.PORT || 8787);
const secret = process.env.CAMERA_RELAY_SECRET || '';
const allowedHosts = new Set(
  String(process.env.CAMERA_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

if (Buffer.byteLength(secret) < 32) {
  throw new Error('CAMERA_RELAY_SECRET must be the same 32+ byte secret configured in Vercel.');
}
if (!allowedHosts.size) {
  throw new Error('Set CAMERA_ALLOWED_HOSTS to the exact camera IP or hostname, for example 192.168.1.6.');
}

function unauthorized(res) {
  res.writeHead(401, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Unauthorized');
}

function createServer() {
  let activeStreams = 0;
  const maxStreams = Math.max(1, Number(process.env.MAX_CAMERA_STREAMS || 8));

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, activeStreams }));
      return;
    }

    const match = requestUrl.pathname.match(/^\/cameras\/(\d+)\/stream$/);
    const token = requestUrl.searchParams.get('token') || '';
    if (req.method !== 'GET' || !match || !token) return unauthorized(res);

    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !/^[a-f0-9]{64}$/i.test(signature)) return unauthorized(res);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest();
    const supplied = Buffer.from(signature, 'hex');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return unauthorized(res);

    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return unauthorized(res);
    }

    if (Number(claims.cameraId) !== Number(match[1]) || !Number.isFinite(claims.expiresAt) || claims.expiresAt < Date.now()) {
      return unauthorized(res);
    }

    let streamUrl;
    try {
      streamUrl = new URL(String(claims.streamUrl || ''));
    } catch {
      return unauthorized(res);
    }
    if (streamUrl.protocol !== 'http:' || streamUrl.username || streamUrl.password || !allowedHosts.has(streamUrl.hostname.toLowerCase())) {
      return unauthorized(res);
    }
    if (activeStreams >= maxStreams) {
      res.writeHead(503, { 'Retry-After': '5', 'Cache-Control': 'no-store' });
      res.end('Camera relay is at capacity.');
      return;
    }

    activeStreams += 1;
    const controller = new AbortController();
    const connectTimeout = setTimeout(() => controller.abort(), 8000);
    let streamFinished = false;
    const finish = () => {
      if (streamFinished) return;
      streamFinished = true;
      clearTimeout(connectTimeout);
      activeStreams = Math.max(0, activeStreams - 1);
      controller.abort();
    };
    res.on('close', finish);

    try {
      const upstream = await fetch(streamUrl, { signal: controller.signal, redirect: 'manual' });
      clearTimeout(connectTimeout);
      if (!upstream.ok || !upstream.body) {
        finish();
        if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' });
        res.end('Camera stream is unavailable.');
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'multipart/x-mixed-replace';
      if (!contentType.toLowerCase().startsWith('multipart/x-mixed-replace')) {
        finish();
        res.writeHead(502, { 'Cache-Control': 'no-store' });
        res.end('Camera did not return an MJPEG stream.');
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      Readable.fromWeb(upstream.body).on('error', finish).pipe(res);
    } catch (error) {
      finish();
      if (res.headersSent) return res.destroy(error);
      res.writeHead(502, { 'Cache-Control': 'no-store' });
      res.end(error.name === 'AbortError' ? 'Timed out connecting to the camera.' : 'Camera stream is unavailable.');
    }
  });
}

createServer().listen(port, '0.0.0.0', () => {
  console.log(`Camera relay listening on port ${port}; allowlisted host count: ${allowedHosts.size}`);
});
