import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'apps/rehab/public');
const manifest = JSON.parse(await readFile(path.join(publicDir, 'cv-assets.json'), 'utf8'));
const dependency = JSON.parse(await readFile(path.join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'));
if (dependency.version !== manifest.packageVersion) throw new Error('MediaPipe package/asset version mismatch');
for (const file of manifest.files) {
  const absolute = path.resolve(publicDir, file.path);
  if (!absolute.startsWith(publicDir + path.sep)) throw new Error('Invalid asset path');
  const data = await readFile(absolute);
  if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) {
    throw new Error('Asset checksum mismatch: ' + file.path);
  }
}
console.log(`Verified ${manifest.files.length} pinned MediaPipe assets (${manifest.packageVersion}, model ${manifest.modelVersion}).`);
