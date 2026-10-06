import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
await mkdir('.tools/android-downloads', { recursive: true });
const java = await (
  await fetch(
    'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse',
  )
).json();
const pkg = java[0].binary.package;
const files = [
  { name: 'jdk.zip', url: pkg.link, hash: pkg.checksum },
  {
    name: 'commandline.zip',
    url: 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip',
    hash: '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a',
  },
];
for (const file of files) {
  const hash = createHash('sha256');
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const stream = Readable.fromWeb(response.body);
  stream.on('data', (b) => hash.update(b));
  await pipeline(stream, createWriteStream('.tools/android-downloads/' + file.name));
  if (hash.digest('hex') !== file.hash) throw new Error(`${file.name}: hash mismatch`);
  console.log('Verified', file.name);
}
