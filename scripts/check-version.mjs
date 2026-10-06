import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const json = (file) => JSON.parse(read(file));
const version = json('package.json').version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const lock = json('package-lock.json');
const versions = {
  client: json('client/package.json').version,
  lock: lock.version,
  rootPackage: lock.packages[''].version,
  clientPackage: lock.packages.client.version,
  desktop: json('shell/desktop/tauri.conf.json').version,
  rust: read('shell/desktop/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1],
  rustLock: read('shell/desktop/Cargo.lock').match(
    /name = "panestra-desktop"\s+version = "([^"]+)"/,
  )?.[1],
  core: read('core/protocol/types.go').match(/CoreVersion\s*=\s*"([^"]+)"/)?.[1],
  packageScript: read('scripts/package.ps1').match(/\$Version = '([^']+)'/)?.[1],
};
for (const [name, actual] of Object.entries(versions))
  assert.equal(actual, version, `${name} version mismatch`);
console.log(`Version ${version}: ${Object.keys(versions).length + 1} definitions agree`);
