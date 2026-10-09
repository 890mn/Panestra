// Generate a Tauri updater feed from already-built, signed release artifacts.
// This script writes local files only; publishing a GitHub Release is separate.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const artifacts = path.join(root, 'artifacts/archive/releases', version);
const windowsName = `Panestra-${version}-windows-x64-setup.exe`;
const signatureFile = path.join(
  root,
  `shell/desktop/target/release/bundle/nsis/Panestra_${version}_x64-setup.exe.sig`,
);
const signature = (await readFile(signatureFile, 'utf8')).trim();
if (!signature || (await stat(path.join(artifacts, windowsName))).size < 1024)
  throw new Error('A signed Windows installer is required');
const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
const notes = changelog
  .split(/^## /m)
  .slice(1)
  .find((section) => section.startsWith(`v${version} `))
  ?.split('\n')
  .slice(1)
  .join('\n')
  .trim();
if (!notes) throw new Error('Current release notes are missing');
const base = `https://github.com/890mn/Panestra/releases/download/v${version}/`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature, url: base + windowsName } },
};
await writeFile(path.join(artifacts, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(artifacts, windowsName + '.sig'), signature + '\n');
const hashes = [];
for (const file of [windowsName, 'latest.json']) {
  const content = await readFile(path.join(artifacts, file));
  hashes.push(`${createHash('sha256').update(content).digest('hex')}  ${file}`);
}
await writeFile(path.join(artifacts, 'UPDATE-SHA256SUMS.txt'), hashes.join('\n') + '\n');
console.log(`Signed Windows update feed v${version} generated; nothing published`);
