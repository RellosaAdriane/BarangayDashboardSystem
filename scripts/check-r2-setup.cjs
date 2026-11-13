require('dotenv').config({ quiet: true });
const { S3Client, HeadBucketCommand, GetBucketCorsCommand } = require('@aws-sdk/client-s3');

(async () => {
  const env = process.env;
  const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
  for (const [label, command] of [
    ['Bucket', new HeadBucketCommand({ Bucket: env.R2_BUCKET })],
    ['CORS', new GetBucketCorsCommand({ Bucket: env.R2_BUCKET })]
  ]) {
    try { const result = await client.send(command); console.log(`${label}: OK`); if (result.CORSRules) console.log(JSON.stringify(result.CORSRules)); }
    catch (error) { console.log(`${label}: ${error.name} (HTTP ${error.$metadata?.httpStatusCode || 'unknown'})`); }
  }
  const db = require('../database');
  try {
    await db.pool.query('SELECT 1'); console.log('Database: connected');
    console.log('Cameras:', JSON.stringify((await db.pool.query('SELECT id,name,is_enabled,is_archived FROM cameras ORDER BY id')).rows));
    console.log('Recording tables:', JSON.stringify((await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('camera_recordings','camera_device_tokens','device_recording_uploads')")).rows));
  } finally { await db.end(); }
})().catch((error) => { console.error('Setup check failed:', error.code || error.name); process.exitCode = 1; });
