import { readFileSync } from 'node:fs';

const ui = readFileSync('packages/widget-schema/src/presentation.ts', 'utf8')
  .split('export const PRESENTATIONS:')[1]
  .split('export const sourcesFor')[0];
const native = readFileSync('core/protocol/presentations.go', 'utf8');
let count = 0;
for (const match of ui.matchAll(/'([^']+)': \[([\s\S]*?)\],/g)) {
  const modes = [...match[2].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  const server = native.match(new RegExp(`"${match[1]}":\\s*\\{([^}]+)\\}`));
  const supported = [...(server?.[1] || '').matchAll(/"([^\"]+)"/g)].map((m) => m[1]);
  if (JSON.stringify(modes) !== JSON.stringify(supported))
    throw new Error(`Presentation contract differs for ${match[1]}`);
  count += modes.length;
}
if (count === 0) throw new Error('No presentation capabilities found');
for (const widget of JSON.parse(readFileSync('core/testdata/system-manifest.json', 'utf8'))
  .widgets) {
  const allowed = native.match(new RegExp(`"${widget.id}":\\s*\\{([^}]+)\\}`));
  const modes = [...(allowed?.[1] || '').matchAll(/"([^\"]+)"/g)].map((m) => m[1]);
  if (JSON.stringify(widget.presentations) !== JSON.stringify(modes))
    throw new Error(`Manifest differs for ${widget.id}`);
}
console.log(`${count} presentation capabilities agree across client, Core and plugin manifest`);
