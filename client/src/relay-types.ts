import type { Identity, Snapshot, Telemetry } from '../../packages/protocol/src';
import type { InstalledPlugin } from './core';

export type RelayInfo = {
  id: string;
  name: string;
  uri: string;
  fingerprint: string;
  serverId: string;
  grants?: Record<string, 'viewer' | 'operator'>;
  status: string;
  error: string;
  online: boolean;
  role: '' | 'viewer' | 'operator';
  identity: Identity | null;
  updatedAt: string;
  snapshot?: Snapshot;
  plugins?: InstalledPlugin[];
  telemetry?: Record<string, Telemetry>;
};
