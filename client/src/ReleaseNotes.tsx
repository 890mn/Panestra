import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { version } from '../package.json';
import changelog from '../../CHANGELOG.md?raw';
import { Button } from './components';
import type { AppRelease } from './app-updates';

const localLogs = changelog
  .split(/^## /m)
  .slice(1)
  .map((section) => {
    const [title, ...body] = section.trim().split('\n');
    return { title, body: body.join('\n').trim() };
  });

export function ReleaseNotes({ release }: { release?: AppRelease | null }) {
  const [detail, setDetail] = useState<{ title: string; body: string } | null>(null);
  return detail ? (
    <div className="release-detail">
      <Button className="secondary" onClick={() => setDetail(null)}>
        <ArrowLeft size={18} />
        返回版本列表
      </Button>
      <h3>{detail.title}</h3>
      <pre>{detail.body || '此版本未提供更新说明'}</pre>
    </div>
  ) : (
    <div className="release-list">
      {release && release.version !== version ? (
        <Button
          className="secondary release-row"
          aria-label={`查看 v${release.version} 更新说明`}
          onClick={() => setDetail({ title: `v${release.version}`, body: release.notes })}
        >
          <span>v{release.version}</span>
          <small>最新发布</small>
        </Button>
      ) : null}
      {localLogs.map((log) => (
        <Button
          className="secondary release-row"
          aria-label={`查看 ${log.title.split(' ')[0]} 更新说明`}
          key={log.title}
          onClick={() => setDetail(log)}
        >
          <span>{log.title}</span>
          {log.title.startsWith(`v${version} `) ? <small>当前版本</small> : null}
        </Button>
      ))}
    </div>
  );
}
