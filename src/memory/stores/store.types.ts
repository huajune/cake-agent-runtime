/** 通用记忆条目 */
export interface MemoryEntry<TContent = Record<string, unknown>> {
  key: string;
  content: TContent;
  updatedAt: string;
}

/** 存储后端统一接口 */
export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | null>;
  set(key: string, content: Record<string, unknown>): Promise<void>;
  del(key: string): Promise<boolean>;
}
