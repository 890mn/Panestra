import { useState } from 'react';
import { ArrowRight, AudioLines, Bot, Code2, Gauge, Network, ShieldCheck } from 'lucide-react';
import { Button, Modal } from './components';
import { CodexAdapterCard } from './CodexAdapter';
import { AccountAdapterCard } from './AccountAdapter';
import { ClashAdapterCard } from './ClashAdapter';

const adapters = [
  {
    id: 'netease',
    name: '网易云音乐',
    category: 'control',
    icon: AudioLines,
    subtitle: '播放控制',
    description: '查看正在播放的歌曲，在屏幕间控制播放',
    fields: ['歌曲与歌手', '播放状态', '播放进度'],
    actions: ['播放 / 暂停', '上一首 / 下一首'],
    route: 'Windows 媒体会话',
    setup:
      '在 Core 电脑上打开网易云音乐，并启用客户端的系统媒体控制，先识别网易云的媒体会话，再授权播放控制',
    boundary:
      '只操作已识别的网易云会话，客户端没有提供媒体会话时显示“未找到播放器”；不把其他播放器当成网易云',
    permissions: ['读取网易云媒体状态', '控制网易云播放（单独授权）'],
    source:
      'https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager',
  },
  {
    id: 'codex',
    name: 'Codex',
    category: 'status',
    icon: Code2,
    subtitle: '任务与额度',
    description: '关注任务进度、等待批准和账号额度',
    fields: ['运行 / 等待批准 / 空闲', '任务标题与更新时间', '额度窗口与重置时间'],
    actions: [],
    route: 'Codex App Server 只读桥接',
    setup:
      '连接实际任务所在的 Codex 实例；通过任务状态事件和账号额度读取获取信息，独立启动的新实例不能代表桌面里正在执行的任务',
    boundary:
      '仅展示状态，不代替你批准任务、发送消息或启动执行，API Key 模式不能假定有 ChatGPT 订阅额度',
    permissions: ['读取已连接实例的任务状态', '读取账号额度（可选）'],
    source: 'https://learn.chatgpt.com/docs/app-server',
  },
  {
    id: 'glm',
    name: 'GLM Coding Plan',
    category: 'status',
    icon: Gauge,
    subtitle: '订阅用量',
    description: '区分不同额度窗口，知道什么时候恢复',
    fields: ['额度已用 / 剩余', '窗口与重置时间', '最近成功同步时间'],
    actions: [],
    route: '智谱中国区官方用量查询',
    setup: '由 Owner 配置智谱中国区个人 Coding Plan API Key，Core 通过官方接口读取额度窗口',
    boundary:
      '使用官方用量查询插件采用的监控接口，未知额度和重置时间保持未知，失败保留上次数据并标明过期',
    permissions: ['读取订阅额度'],
    source: 'https://docs.bigmodel.cn/cn/coding-plan/extension/usage-query-plugin',
  },
  {
    id: 'clash',
    name: 'Clash Verge',
    category: 'control',
    icon: Network,
    subtitle: '代理控制',
    description: '查看代理模式与流量，切换模式和节点',
    fields: ['代理模式', '策略组与当前节点', '实时收发流量'],
    actions: ['规则 / 全局 / 直连', '切换策略组节点'],
    route: '本机 Mihomo 控制器',
    setup:
      '在 Core 电脑上配置控制器地址及 Secret，由 Core 访问本机控制器，平板只连接 Panestra，先读状态，再单独授权模式与节点切换',
    boundary:
      '本轮设计针对 Mihomo 内核，Windows 系统代理和 TUN 属于另一组权限，不把内核模式切换当成系统代理开关',
    permissions: ['读取代理状态', '切换模式与节点（单独授权）'],
    source: 'https://wiki.metacubex.one/api/',
  },
  {
    id: 'alas',
    name: 'ALAS',
    category: 'status',
    icon: Bot,
    subtitle: '脚本状态',
    description: '查看 Azur Lane AutoScript 实例和当前任务',
    fields: ['实例运行状态', '当前任务与下次执行', '异常摘要与最近更新时间'],
    actions: [],
    route: 'ALAS 本机只读桥接',
    setup:
      '选定 ALAS 实例，通过与版本匹配的只读桥输出状态，桥接需要读取 ProcessManager 和任务调度状态，不依赖网页抓取',
    boundary:
      'ALAS 网页内部状态不等于公开 REST API，桥接断开显示“未知 / 数据过期”，不根据 Python 进程存在就认定任务运行正常',
    permissions: ['读取指定 ALAS 实例状态'],
    source: 'https://github.com/LmeSzinc/AzurLaneAutoScript/blob/master/module/webui/app.py',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'status',
    icon: Gauge,
    subtitle: '账户余额',
    description: '查看可用余额、赠送余额和充值余额',
    fields: ['可用余额', '最近同步时间'],
    actions: [],
    route: 'DeepSeek 官方余额接口',
    setup: '在设置中配置 API Key',
    boundary: '仅查询余额，不发起模型调用',
    permissions: ['读取账户余额'],
    source: 'https://api-docs.deepseek.com/api/get-user-balance',
  },
] as const;

export function SoftwareAdapters() {
  const [filter, setFilter] = useState('all');
  const [detail, setDetail] = useState<(typeof adapters)[number] | null>(null);
  return (
    <section className="software-adapters" aria-labelledby="software-heading">
      <div className="adapter-section-heading">
        <div>
          <h2 id="software-heading">软件适配</h2>
          <p>先接入常用软件，控制权限与状态读取分开</p>
        </div>
        <span className="badge">4 项已实现 · 2 项设计</span>
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
          .map((item) =>
            item.id === 'codex' ? (
              <CodexAdapterCard key={item.id} />
            ) : item.id === 'clash' ? (
              <ClashAdapterCard key={item.id} />
            ) : item.id === 'glm' || item.id === 'deepseek' ? (
              <AccountAdapterCard id={item.id} key={item.id} />
            ) : (
              <article className="adapter-card panel" key={item.id}>
                <div className="adapter-card-heading">
                  <span className="adapter-icon">
                    <item.icon size={22} />
                  </span>
                  <span className="adapter-state">
                    <span className="status-light offline" />
                    未接入
                  </span>
                </div>
                <h3>{item.name}</h3>
                <span className="adapter-subtitle">{item.subtitle}</span>
                <p>{item.description}</p>
                <div className="adapter-fields">
                  {item.fields.slice(0, 2).map((field) => (
                    <div key={field}>
                      <span>{field}</span>
                      <span className="mono">—</span>
                    </div>
                  ))}
                </div>
                <Button
                  className="secondary"
                  aria-label={`查看${item.name}接入设计`}
                  onClick={() => setDetail(item)}
                >
                  查看接入设计
                  <ArrowRight size={16} />
                </Button>
              </article>
            ),
          )}
      </div>
      <div className="quiet-note">
        <ShieldCheck size={18} />
        <p>账户凭据与本机控制器连接由 Core 管理，控制操作需要单独授权</p>
      </div>
      {detail ? (
        <Modal title={`${detail.name} · 接入设计`} close={() => setDetail(null)}>
          <div className="adapter-detail">
            <span className="badge">待实现</span>
            <h3>{detail.route}</h3>
            <p>{detail.setup}</p>
            <h3>状态内容</h3>
            <ul>
              {detail.fields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
            {detail.actions.length ? (
              <>
                <h3>控制操作</h3>
                <ul>
                  {detail.actions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <h3>权限范围</h3>
            <ul>
              {detail.permissions.map((permission) => (
                <li key={permission}>{permission}</li>
              ))}
            </ul>
            <div className="adapter-boundary">{detail.boundary}</div>
            <p className="subtle">
              接口依据：
              <a href={detail.source} target="_blank" rel="noreferrer">
                官方文档 / 源码
              </a>
            </p>
            <Button className="primary" onClick={() => setDetail(null)}>
              完成查看
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
