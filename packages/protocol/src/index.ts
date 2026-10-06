export type Role = 'owner' | 'operator' | 'viewer';
export type Breakpoint = 'desktop' | 'tablet' | 'mobile';
export type EntityKind = 'workspace' | 'page' | 'widget' | 'layout';
export interface Entity<T = Record<string, unknown>> {
  id: string;
  kind: EntityKind;
  rev: number;
  deleted?: boolean;
  data: T;
}
export interface Layout {
  widgetId: string;
  breakpoint: Breakpoint;
  x: number;
  y: number;
  w: number;
  h: number;
  detached?: boolean;
}
export interface WidgetBlock {
  order: number;
  column: number;
  span: number;
  align: 'start' | 'center' | 'end';
  visible: boolean;
}
export interface WidgetProfile {
  presentation: string;
  chartStyle: 'line' | 'area';
  blocks: Record<string, WidgetBlock>;
}
export interface Widget {
  pageId: string;
  pluginId: string;
  type: 'metric-card' | 'network-chart' | 'system-overview' | 'codex-usage' | 'account-usage';
  title: string;
  source: string;
  unit?: string;
  color?: string;
  presentation?: string;
  chartStyle?: 'line' | 'area';
  sizeProfiles?: Record<string, WidgetProfile>;
}
export interface Page {
  title: string;
  workspaceId: string;
  icon?: string;
}
export interface Device {
  id: string;
  name: string;
  publicKey?: string;
  role: Role;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}
export interface Snapshot {
  type: 'snapshot';
  serverSeq: number;
  entities: Entity[];
}
export interface CanonicalEvent {
  type: 'event';
  serverSeq: number;
  causedBy: string;
  deviceId: string;
  entity: Entity;
  entities?: Entity[];
}
export interface Command {
  opId: string;
  deviceId: string;
  entityId: string;
  baseRev: number;
  command: string;
  payload: unknown;
}
export interface Telemetry {
  type: 'telemetry';
  topic: string;
  seq: number;
  ts: string;
  value: number | SystemInfo | CodexStatus | AccountStatus;
}
export interface SystemInfo {
  hostname: string;
  os: string;
  cpu: string;
  cores: number;
  memoryGB: number;
  uptime: number;
}
export interface Endpoint {
  uri: string;
  serverId: string;
  publicKeyHash: string;
  priority: number;
  lastSuccess?: string;
  lastRTT?: number;
}
export interface Identity {
  serverId: string;
  fingerprint: string;
  apiVersion: number;
  coreVersion: string;
  publicKey?: string;
  proof?: string;
  signature?: string;
}
export interface APIError {
  code: string;
  message: string;
  currentRev?: number;
  currentState?: Entity;
}
export interface Plugin {
  id: string;
  name: string;
  version: string;
  status: string;
  restarts: number;
  permissions: Record<string, boolean>;
  pid: number;
}
export const SYSTEM = 'dev.panestra.system';
export const CODEX = 'dev.panestra.codex';
export const CODEX_TOPIC = `${CODEX}/account.usage`;
export const ACCOUNT_IDS = ['glm', 'deepseek'] as const;
export const accountTopic = (id: string) => `dev.panestra.${id}/account.usage`;
export interface AccountWindow {
  id: string;
  name: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  current: number | null;
  limit: number | null;
  resetsAt: number | null;
}
export interface AccountBalance {
  currency: 'CNY' | 'USD';
  total: string;
  granted: string;
  toppedUp: string;
}
export interface AccountStatus {
  id: string;
  enabled: boolean;
  hasCredential: boolean;
  state: string;
  message: string;
  updatedAt?: string;
  stale: boolean;
  refreshing: boolean;
  pollIntervalSeconds: number;
  windows: AccountWindow[];
  balances: AccountBalance[];
  available: boolean | null;
}
export interface CodexWindow {
  id: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  durationMinutes: number | null;
  resetsAt: number | null;
}
export interface CodexBucket {
  id: string;
  name: string;
  windows: CodexWindow[];
}
export interface CodexStatus {
  enabled: boolean;
  state: string;
  message: string;
  planType?: string;
  updatedAt?: string;
  stale: boolean;
  refreshing: boolean;
  buckets: CodexBucket[];
  resetCredits: { availableCount: number | null; expiresAt: number | null } | null;
  pollIntervalSeconds: number;
}
export const SOURCES = [
  'cpu.usage',
  'memory.usage',
  'disk.usage',
  'network.rx',
  'network.tx',
  'system.info',
];
