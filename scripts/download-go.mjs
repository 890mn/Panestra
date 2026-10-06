import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const releases = await (await fetch('https://go.dev/dl/?mode=json')).json();
const file = releases[0].files.find(
  (f) => f.os === 'windows' && f.arch === 'amd64' && f.kind === 'archive',
);
const data = Buffer.from(await (await fetch(`https://go.dev/dl/${file.filename}`)).arrayBuffer());
if (createHash('sha256').update(data).digest('hex') !== file.sha256)
  throw new Error('Go checksum mismatch');
await mkdir('.tools', { recursive: true });
await writeFile('.tools/go.zip', data);
console.log(`Verified ${file.filename}: ${file.sha256}`);
