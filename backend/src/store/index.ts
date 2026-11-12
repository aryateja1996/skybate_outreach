import type { AppConfig } from '../config';
import { MemoryStore } from './memory';
import { createMysqlStore } from './mysql';
import type { Store } from './types';

export async function createStore(config: AppConfig): Promise<Store> {
  if (config.dataStore === 'memory') return new MemoryStore();
  return createMysqlStore(config);
}

export type { Store } from './types';
export { MemoryStore } from './memory';
