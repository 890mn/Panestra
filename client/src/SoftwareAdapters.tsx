import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from './components';
import { CodexAdapterCard } from './CodexAdapter';
import { AccountAdapterCard } from './AccountAdapter';
import { ClashAdapterCard } from './ClashAdapter';
import { MusicAdapterCard } from './MusicAdapter';
import { AlasAdapterCard } from './AlasAdapter';
const adapters = [
  { id: 'netease', category: 'control', render: () => <MusicAdapterCard /> },
  { id: 'codex', category: 'status', render: () => <CodexAdapterCard /> },
  { id: 'glm', category: 'status', render: () => <AccountAdapterCard id="glm" /> },
  { id: 'clash', category: 'control', render: () => <ClashAdapterCard /> },
  { id: 'alas', category: 'status', render: () => <AlasAdapterCard /> },
  { id: 'deepseek', category: 'status', render: () => <AccountAdapterCard id="deepseek" /> },
];
export function SoftwareAdapters() {
  const [filter, setFilter] = useState('all');
  return (
    <section className="software-adapters" aria-labelledby="software-heading">
      <div className="adapter-section-heading">
        <div>
          <h2 id="software-heading">软件适配</h2>
          <p>接入常用软件，控制权限与状态读取分开</p>
        </div>
        <span className="badge">6 项已实现</span>
      </div>
      <div className="adapter-filter" aria-label="软件适配筛选">
        {[
          { id: 'all', title: '全部' },
          { id: 'control', title: '控制' },
          { id: 'status', title: '状态' },
        ].map((item) => (
          <Button
            key={item.id}
            className="status-button"
            selected={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.title}
          </Button>
        ))}
      </div>
      <div className="adapter-grid">
        {adapters
          .filter((item) => filter === 'all' || item.category === filter)
          .map((item) => (
            <item.render key={item.id} />
          ))}
      </div>
      <div className="quiet-note">
        <ShieldCheck size={18} />
        <p>账户凭据与本机连接由 Core 管理，控制操作需要单独授权</p>
      </div>
    </section>
  );
}
