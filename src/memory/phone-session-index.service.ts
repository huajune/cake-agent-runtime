import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';

/**
 * 手机号 → 会话键的轻量映射（带外工单补偿扫描的反查索引）。
 *
 * 仓库没有按手机号索引会话的表；扫描拿到海绵工单里的手机号后，只能靠这份 Redis 映射
 * 找回 {corpId,userId,chatId,botImId}。写入口是会话事实/长期档案落本人手机号的地方
 * （收资逐格落定、办结、报名成功）以及每轮 prepare 解析到本人手机号时的刷新；
 * 多会话共用一个手机号时取最近写入。TTL 30 天，与扫描的 15 天报名窗覆盖一致。
 *
 * 只是索引，不是事实：读不到就是"反查不到"，由扫描落观测跳过，不做任何推断。
 */
@Injectable()
export class PhoneSessionIndexService {
  private readonly logger = new Logger(PhoneSessionIndexService.name);
  /** 同一进程内同一手机号 1 小时只写一次，避免每轮 prepare 都打 Redis。 */
  private readonly recentWrites = new Map<string, number>();

  constructor(private readonly redis: RedisService) {}

  async record(phone: string, ref: PhoneSessionRef): Promise<void> {
    const normalized = phone.trim();
    if (!isStorableCandidatePhone(normalized)) return;
    // 兜底：测试/调试链路的会话一律不进索引（上游已按 callerKind / strategySource 拦，这里按身份再挡一道）。
    if (isNonProductionSessionRef(ref)) return;
    const dedupeKey = `${normalized}:${ref.chatId}:${ref.botImId ?? ''}`;
    const last = this.recentWrites.get(dedupeKey);
    const now = Date.now();
    if (last != null && now - last < WRITE_DEDUPE_MS) return;
    this.recentWrites.set(dedupeKey, now);
    if (this.recentWrites.size > MAX_DEDUPE_ENTRIES) this.recentWrites.clear();

    const record: PhoneSessionIndexRecord = { ...ref, phone: normalized, updatedAt: now };
    try {
      await Promise.all([
        this.redis.setex(phoneKey(normalized), INDEX_TTL_SECONDS, record),
        this.redis.setex(chatKey(ref.chatId), INDEX_TTL_SECONDS, record),
      ]);
    } catch (error) {
      this.recentWrites.delete(dedupeKey);
      this.logger.warn(
        `手机号→会话索引写入失败 phoneTail=${normalized.slice(-4)}: ${toErrorMessage(error)}`,
      );
    }
  }

  async lookupByPhone(phone: string): Promise<PhoneSessionIndexRecord | null> {
    const normalized = phone.trim();
    if (!isStorableCandidatePhone(normalized)) return null;
    return this.read(phoneKey(normalized));
  }

  async lookupByChat(chatId: string): Promise<PhoneSessionIndexRecord | null> {
    if (!chatId.trim()) return null;
    return this.read(chatKey(chatId.trim()));
  }

  private async read(key: string): Promise<PhoneSessionIndexRecord | null> {
    try {
      const value = await this.redis.get<PhoneSessionIndexRecord>(key);
      return isIndexRecord(value) ? value : null;
    } catch (error) {
      this.logger.warn(`手机号→会话索引读取失败 key=${key}: ${toErrorMessage(error)}`);
      return null;
    }
  }
}

export interface PhoneSessionRef {
  corpId: string;
  userId: string;
  chatId: string;
  botImId?: string | null;
}

export interface PhoneSessionIndexRecord extends PhoneSessionRef {
  phone: string;
  updatedAt: number;
}

const INDEX_TTL_SECONDS = 30 * 24 * 60 * 60;
const WRITE_DEDUPE_MS = 60 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 5_000;
/** 测试套件 / 调试端点的会话身份：corpId 固定为 test / debug，或 chatId 带固定测试前缀。 */
const NON_PRODUCTION_CORP_IDS: ReadonlySet<string> = new Set(['test', 'debug']);
const NON_PRODUCTION_CHAT_ID_PREFIXES = ['test-', 'p1-fixed-', 'p2-fixed-', 'p3-fixed-'] as const;

export function isNonProductionSessionRef(
  ref: Pick<PhoneSessionRef, 'corpId' | 'chatId'>,
): boolean {
  if (NON_PRODUCTION_CORP_IDS.has(ref.corpId.trim())) return true;
  const chatId = ref.chatId.trim();
  return NON_PRODUCTION_CHAT_ID_PREFIXES.some((prefix) => chatId.startsWith(prefix));
}

function phoneKey(phone: string): string {
  return `oob:phone:${phone}`;
}

function chatKey(chatId: string): string {
  return `oob:chat:${chatId}`;
}

function isIndexRecord(value: unknown): value is PhoneSessionIndexRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.corpId === 'string' &&
    typeof record.userId === 'string' &&
    typeof record.chatId === 'string' &&
    typeof record.phone === 'string'
  );
}
