import type { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

export interface CachedChatHistoryMessage {
  chatId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** 消息来源元数据；用于区分真人招募经理与 Agent/自动消息。 */
  source?: StorageMessageSource;
  messageType?: StorageMessageType;
  isSelf?: boolean;
  /** 仅保留 payload.source，避免把完整回调 payload 放大到短期缓存。 */
  payloadSource?: string;
  /** v2 表示该条已走 provenance-aware writer/backfill；兼容滚动发布时的旧缓存。 */
  provenanceVersion?: 2;
}

const CHAT_HISTORY_CACHE_PREFIX = 'memory:short_term:chat';

export function buildChatHistoryCacheKey(chatId: string): string {
  return `${CHAT_HISTORY_CACHE_PREFIX}:${chatId}`;
}

/** 只依赖 `eval`，让 biz 侧 append 与 memory 侧 rebuild 共用同一套脚本而不引入 RedisService 类型。 */
export interface ChatHistoryCacheRedis {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

export interface ChatHistoryCacheLimits {
  maxMessages: number;
  ttlSeconds: number;
}

/**
 * 写路径追加：RPUSHX 只在 list 已存在时追加，绝不创建 key。
 *
 * list 的唯一创建者是 `rebuildChatHistoryCache`（DB 完整快照）。若写路径用 RPUSH 建 key，
 * `updateMessageContent` DEL 之后到达的第一条消息会把 list 建成「只含自己」的残缺快照，
 * 而读路径把任何非空 v2 list 当完整历史——整段前文就此从 Agent 上下文消失。
 * ARGV: [maxMessages, ttlSeconds, payload]；返回 false 表示 key 不存在、未追加。
 */
const APPEND_SCRIPT = `
  local n = redis.call("RPUSHX", KEYS[1], ARGV[3])
  if n == 0 then return 0 end
  redis.call("LTRIM", KEYS[1], -tonumber(ARGV[1]), -1)
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
  return n
`;

/**
 * 读路径回填：DEL + RPUSH 全量 + LTRIM + EXPIRE 在一个脚本内完成。
 *
 * 拆成多次往返时，并发的写路径追加可能落在 DEL 与 RPUSH 之间，得到乱序/重复条目。
 * 仍存在的窄窗口：DB 快照查询之后、脚本执行之前追加的消息会被快照覆盖掉，
 * 下次 miss 才从 DB 补回；DB 始终是权威，缓存只是速取镜像。
 * ARGV: [maxMessages, ttlSeconds, ...payloads]。
 */
const REBUILD_SCRIPT = `
  redis.call("DEL", KEYS[1])
  for i = 3, #ARGV do
    redis.call("RPUSH", KEYS[1], ARGV[i])
  end
  redis.call("LTRIM", KEYS[1], -tonumber(ARGV[1]), -1)
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
  return #ARGV - 2
`;

export async function appendChatHistoryCacheEntry(
  redis: ChatHistoryCacheRedis,
  chatId: string,
  serializedMessage: string,
  limits: ChatHistoryCacheLimits,
): Promise<boolean> {
  const result = await redis.eval(
    APPEND_SCRIPT,
    [buildChatHistoryCacheKey(chatId)],
    [limits.maxMessages, limits.ttlSeconds, serializedMessage],
  );
  return Number(result) > 0;
}

export async function rebuildChatHistoryCache(
  redis: ChatHistoryCacheRedis,
  chatId: string,
  serializedMessages: string[],
  limits: ChatHistoryCacheLimits,
): Promise<void> {
  if (serializedMessages.length === 0) return;
  await redis.eval(
    REBUILD_SCRIPT,
    [buildChatHistoryCacheKey(chatId)],
    [limits.maxMessages, limits.ttlSeconds, ...serializedMessages],
  );
}

export function serializeCachedChatHistoryMessage(message: CachedChatHistoryMessage): string {
  return JSON.stringify(message);
}

export function parseCachedChatHistoryMessages(rawMessages: string[]): CachedChatHistoryMessage[] {
  return rawMessages
    .map((raw) => {
      try {
        return JSON.parse(raw) as Partial<CachedChatHistoryMessage>;
      } catch {
        return null;
      }
    })
    .filter((message): message is CachedChatHistoryMessage => {
      return Boolean(
        message &&
          typeof message.chatId === 'string' &&
          typeof message.messageId === 'string' &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string' &&
          typeof message.timestamp === 'number',
      );
    });
}
