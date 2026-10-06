import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('.tools/vs-manifest.json', 'utf8'));
const prefix = 'Microsoft.VC.14.44.17.14.';
const ids = [
  'Tools.HostX64.TargetX64.base',
  'Tools.HostX64.TargetX64.Res.base',
  'CRT.Headers.base',
  'CRT.x64.Desktop.base',
  'ATL.Headers.base',
  'ATL.X64.base',
];
await mkdir('.tools/msvc-packages', { recursive: true });
const seen = new Set();
for (const id of ids) {
  const packages = manifest.packages.filter(
    (p) => p.id === prefix + id && (!p.language || p.language === 'en-US'),
  );
  for (const pkg of packages)
    for (const payload of pkg.payloads || []) {
      if (seen.has(payload.fileName)) continue;
      seen.add(payload.fileName);
      if (/\.Res\./.test(id) && !payload.fileName.includes('.enu.')) continue;
      const bytes = Buffer.from(await (await fetch(payload.url)).arrayBuffer());
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (payload.sha256 && hash.toLowerCase() !== payload.sha256.toLowerCase())
        throw new Error('Microsoft package hash mismatch');
      await writeFile('.tools/msvc-packages/' + payload.fileName.replace(/\.vsix$/, '.zip'), bytes);
      console.log('Verified', payload.fileName, bytes.length);
    }
}
