import { get, update } from 'idb-keyval';

let names: Record<string, string> = {};
export async function loadCoreNames() {
  names = (await get<Record<string, string>>('panestra.core-names.v1')) || {};
}
export function coreName(id?: string) {
  return id ? names[id] : undefined;
}
export async function saveCoreName(id: string, name: string) {
  names =
    (await update<Record<string, string>>('panestra.core-names.v1', (saved = {}) => {
      const next = { ...saved };
      if (name.trim()) next[id] = name.trim();
      else delete next[id];
      return next;
    }).then(() => get<Record<string, string>>('panestra.core-names.v1'))) || {};
}
