import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const assets = path.resolve(root, 'core/web/dist/assets');
if (!assets.startsWith(root + path.sep)) throw new Error('Invalid build directory');
try {
  for (const entry of await readdir(assets, { withFileTypes: true }))
    if (entry.isFile()) await unlink(path.join(assets, entry.name));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
