const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports = function createR2Storage(env = process.env) {
  let client;
  function connection() {
    if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
      const error = new Error('Configure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.');
      error.status = 503;
      throw error;
    }
    client ||= new S3Client({
      region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED'
    });
    return client;
  }
  const object = (Key) => ({ Bucket: env.R2_BUCKET, Key });
  return {
    uploadUrl: (key, size) => getSignedUrl(connection(), new PutObjectCommand({ ...object(key), ContentType: 'video/x-msvideo', ContentLength: size, IfNoneMatch: '*' }), { expiresIn: 900, signableHeaders: new Set(['content-type']) }),
    videoUrl: (key, download = false) => getSignedUrl(connection(), new GetObjectCommand({ ...object(key), ResponseContentType: 'video/x-msvideo', ResponseContentDisposition: `${download ? 'attachment' : 'inline'}; filename="${key.split('/').pop()}"` }), { expiresIn: 900 }),
    head: (key) => connection().send(new HeadObjectCommand(object(key))),
    // A small range validates the RIFF/AVI header without passing video through Vercel.
    async header(key) {
      const response = await connection().send(new GetObjectCommand({ ...object(key), Range: 'bytes=0-223' }));
      return Buffer.from(await response.Body.transformToByteArray());
    },
    remove: (key) => connection().send(new DeleteObjectCommand(object(key)))
  };
};
