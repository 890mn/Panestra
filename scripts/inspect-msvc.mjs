import { writeFile } from 'node:fs/promises';
const channel = await (await fetch('https://aka.ms/vs/17/release/channel')).json();
const item = channel.channelItems.find(
  (x) => x.id === 'Microsoft.VisualStudio.Manifests.VisualStudio',
);
const manifest = await (await fetch(item.payloads[0].url)).json();
await writeFile('.tools/vs-manifest.json', JSON.stringify(manifest));
for (const p of manifest.packages.filter(
  (x) =>
    /^Microsoft\.VC\./.test(x.id) &&
    /HostX64.TargetX64|CRT.Headers|CRT.X64.Desktop|ATL.Headers|ATL.X64/.test(x.id),
))
  console.log(
    p.id,
    p.payloads?.map((x) => ({ name: x.fileName, size: x.size, url: x.url })),
  );
