/**
 * 收资表单快照的 Redis 存储（蓝图 §4）。
 *
 * 形态裁定（v3-lean §0）：**整实体 JSON 快照，无版本锁、无 CAS**。
 * 并发安全不靠乐观锁，靠消息处理的 90s 回合租约（心跳续期）——同一会话同一时刻
 * 只有一个 worker 在跑回合，表单只在回合内写。为不存在的并发建 CAS 是白付往返。
 *
 * ⚠️ **本 key 属「丢了算事故」清单**：表单是收资进度的唯一事实源。丢了不是"少一段
 * 记忆"，是候选人已经答过的每一格都要重问一遍——正是本改造要根治的那个病。
 * TTL 与会话事实同档（会话级），跨会话回来重新开表是预期行为。
 */

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import type { BookingCollectionForm } from '@resolution/collection';

/** 收资单据自持 TTL：默认 3 天；与会话状态对齐是业务口径，不依赖 MemoryConfig。 */
export const COLLECTION_FORM_TTL_SECONDS = 3 * 24 * 60 * 60;

interface CollectionFormStoreEntry {
  key: string;
  content: Record<string, unknown>;
  updatedAt: string;
}

/** key 形态：`collection-form:{corpId}:{userId}:{candidateRef}:{jobId}`（蓝图 §4 原样）。 */
export function buildCollectionFormKey(params: {
  corpId: string;
  userId: string;
  candidateRef: string;
  jobId: number;
}): string {
  return `collection-form:${params.corpId}:${params.userId}:${params.candidateRef}:${params.jobId}`;
}

/**
 * 当前会话/岗位正在办理的人键指针。
 *
 * 手机号写进表单后实体会从 `session` 搬到手机号 key；后续 booking 工具不再接收
 * candidatePhone，因此必须有一个同会话、同岗位的稳定定位入口，不能靠调用方重复传 PII。
 */
export function buildCollectionFormLocatorKey(params: {
  corpId: string;
  userId: string;
  jobId: number;
}): string {
  return `collection-form-current:${params.corpId}:${params.userId}:${params.jobId}`;
}

@Injectable()
export class CollectionFormStore {
  private readonly logger = new Logger(CollectionFormStore.name);

  constructor(private readonly redis: RedisService) {}

  async read(params: {
    corpId: string;
    userId: string;
    candidateRef: string;
    jobId: number;
  }): Promise<BookingCollectionForm | null> {
    const entry = await this.redis.get<CollectionFormStoreEntry>(buildCollectionFormKey(params));
    const content = entry?.content;
    if (!content || typeof content !== 'object') return null;
    return content as unknown as BookingCollectionForm;
  }

  async readCurrentCandidateRef(params: {
    corpId: string;
    userId: string;
    jobId: number;
  }): Promise<string | null> {
    const entry = await this.redis.get<CollectionFormStoreEntry>(
      buildCollectionFormLocatorKey(params),
    );
    const content = entry?.content;
    if (!content || typeof content !== 'object') return null;
    const candidateRef = (content as { candidateRef?: unknown }).candidateRef;
    return typeof candidateRef === 'string' && candidateRef.length > 0 ? candidateRef : null;
  }

  /** 整实体覆盖写（merge=false）：表单的写路径纯函数已产出完整新实体，deepMerge 只会把删掉的槽位又粘回来。 */
  async write(
    params: { corpId: string; userId: string },
    form: BookingCollectionForm,
  ): Promise<void> {
    const formKey = buildCollectionFormKey({
      corpId: params.corpId,
      userId: params.userId,
      candidateRef: form.candidateRef,
      jobId: form.jobId,
    });
    const locatorKey = buildCollectionFormLocatorKey({
      corpId: params.corpId,
      userId: params.userId,
      jobId: form.jobId,
    });
    await this.writeSnapshot(formKey, form as unknown as Record<string, unknown>);
    await this.writeSnapshot(locatorKey, { candidateRef: form.candidateRef });
  }

  async remove(params: {
    corpId: string;
    userId: string;
    candidateRef: string;
    jobId: number;
  }): Promise<void> {
    await this.redis.del(buildCollectionFormKey(params));
    const currentRef = await this.readCurrentCandidateRef(params);
    if (currentRef === params.candidateRef) {
      await this.redis.del(buildCollectionFormLocatorKey(params));
    }
  }

  private async writeSnapshot(key: string, content: Record<string, unknown>): Promise<void> {
    await this.redis.setex(key, COLLECTION_FORM_TTL_SECONDS, {
      key,
      content,
      updatedAt: new Date().toISOString(),
    } satisfies CollectionFormStoreEntry);
    this.logger.debug(`收资单据已存储: ${key}`);
  }
}
