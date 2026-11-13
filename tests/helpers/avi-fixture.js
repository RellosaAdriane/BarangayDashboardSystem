const fs = require('node:fs');
const path = require('node:path');
// Real JPEG payload; AVI structure follows Microsoft's RIFF format.
module.exports = function aviFixture(frameCount = 3) {
  const jpeg = fs.readFileSync(path.join(__dirname, '../../public/images/logo.jpg'));
  const header = Buffer.alloc(224);
  const tag = (offset, value) => header.write(value, offset, 'ascii');
  const n = (offset, value) => header.writeUInt32LE(value, offset);
  tag(0, 'RIFF'); tag(8, 'AVI '); tag(12, 'LIST'); n(16, 192); tag(20, 'hdrl');
  tag(24, 'avih'); n(28, 56); n(32, 200000); n(44, 16); n(48, frameCount); n(56, 1); n(64, 320); n(68, 240);
  tag(88, 'LIST'); n(92, 116); tag(96, 'strl'); tag(100, 'strh'); n(104, 56); tag(108, 'vids'); tag(112, 'MJPG');
  n(128, 1); n(132, 5); n(140, frameCount); tag(164, 'strf'); n(168, 40); n(172, 40); n(176, 320); n(180, 240);
  header.writeUInt16LE(1, 184); header.writeUInt16LE(24, 186); tag(188, 'MJPG'); tag(212, 'LIST'); tag(220, 'movi');
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const chunk = Buffer.alloc(8 + jpeg.length + (jpeg.length & 1)); chunk.write('00dc'); chunk.writeUInt32LE(jpeg.length, 4); jpeg.copy(chunk, 8); frames.push(chunk);
  }
  const movie = Buffer.concat(frames); n(216, movie.length + 4);
  const index = Buffer.alloc(8 + frameCount * 16); index.write('idx1'); index.writeUInt32LE(frameCount * 16, 4);
  for (let i = 0; i < frameCount; i++) { const o = 8 + i * 16; index.write('00dc', o); index.writeUInt32LE(16, o + 4); index.writeUInt32LE(4 + i * frames[i].length, o + 8); index.writeUInt32LE(jpeg.length, o + 12); }
  n(4, header.length + movie.length + index.length - 8);
  return Buffer.concat([header, movie, index]);
};
