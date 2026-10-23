/**
 * 收资表单快照的 Redis 存储（蓝图 §4）。
 *
 * 形态裁定（v3-lean §0）：**整实体 JSON 快照，回合写入无版本锁**。
 * 并发安全不靠乐观锁，靠消息处理的 90s 回合租约（心跳续期）——同一会话同一时刻
 * 只有一个 worker 在跑回合。后台动作补账使用单独的条件办结写，禁止覆盖回合内新资料。
 *
 * ⚠️ **本 key 属「丢了算事故」清单**：表单是收资进度的唯一事实源。丢了不是"少一段
 * 记忆"，是候选人已经答过的每一格都要重问一遍——正是本改造要根治的那个病。
 * TTL 与会话事实同档（会话级），跨会话回来重新开表是预期行为。
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { markSubmitted } from '@resolution/collection';
import { RedisService } from '@infra/redis/redis.service';
import type { BookingCollectionForm } from '@resolution/collection';

/** 收资单据自持 TTL：默认 7 天；与会话状态对齐是业务口径，不依赖 MemoryConfig。 */
export const COLLECTION_FORM_TTL_SECONDS = 7 * 24 * 60 * 60;

interface CollectionFormStoreEntry {
  key: string;
  content: Record<string, unknown>;
  updatedAt: string;
}

/** key 形态：`collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}`。 */
export function buildCollectionFormKey(params: {
  corpId: string;
  userId: string;
  botUserId: string;
  candidateRef: string;
  jobId: number;
}): string {
  return `collection-form:${params.corpId}:${params.userId}:${params.botUserId}:${params.candidateRef}:${params.jobId}`;
}

/**
 * 当前会话/岗位最近一次推进的人键指针。
 *
 * booking 工具不接收 candidatePhone，必须沿用刚刚通过 precheck 的活动表单；多人代报时
 * 这里可以短暂指向 additional 候选人。
 */
export function buildCollectionFormLocatorKey(params: {
  corpId: string;
  userId: string;
  botUserId: string;
  jobId: number;
}): string {
  return `collection-form-current:${params.corpId}:${params.userId}:${params.botUserId}:${params.jobId}`;
}

/**
 * 当前联系人的主表单指针。
 *
 * 与活动指针分开：additional 候选人需要成为 booking 的活动表单，但不能把后续“不传手机号”
 * 的主候选人 precheck 路由到 additional 表单。
 */
export function buildCollectionFormPrimaryLocatorKey(params: {
  corpId: string;
  userId: string;
  botUserId: string;
  jobId: number;
}): string {
  return `collection-form-primary:${params.corpId}:${params.userId}:${params.botUserId}:${params.jobId}`;
}

@Injectable()
export class CollectionFormStore {
  private readonly logger = new Logger(CollectionFormStore.name);

  constructor(private readonly redis: RedisService) {}

  async read(params: {
    corpId: string;
    userId: string;
    botUserId: string;
    candidateRef: string;
    jobId: number;
  }): Promise<BookingCollectionForm | null> {
    const entry = await this.redis.get<CollectionFormStoreEntry>(buildCollectionFormKey(params));
    const content = entry?.content;
    if (!content || typeof content !== 'object') return null;
    return content as unknown as BookingCollectionForm;
  }

  /** 后台补账只办结原版表单，不覆盖新资料、不重新创建已过期表单，也不修改活动人键。 */
  async markSubmittedIfUnchanged(
    params: {
      corpId: string;
      userId: string;
      botUserId: string;
      candidateRef: string;
      jobId: number;
    },
    expectedDigest: string,
    workOrderId: number,
  ): Promise<boolean> {
    const key = buildCollectionFormKey(params);
    const entry = await this.redis.get<CollectionFormStoreEntry>(key);
    if (!entry?.content) return false;
    const form = entry.content as unknown as BookingCollectionForm;
    const originalForm = { ...form };
    if (form.workOrderId === workOrderId) delete originalForm.workOrderId;
    if (form.workOrderId === workOrderId)
      return (
        createHash('sha256').update(JSON.stringify(originalForm)).digest('hex') === expectedDigest
      );
    if (createHash('sha256').update(JSON.stringify(form)).digest('hex') !== expectedDigest)
      return false;
    const replacement = {
      ...entry,
      content: markSubmitted(form, workOrderId),
      updatedAt: new Date().toISOString(),
    };
    const changed = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL'); return 1",
      [key],
      [JSON.stringify(entry), JSON.stringify(replacement)],
    );
    return changed === 1;
  }

  async readCurrentCandidateRef(params: {
    corpId: string;
    userId: string;
    botUserId: string;
    jobId: number;
  }): Promise<string | null> {
    return this.readLocatorCandidateRef(buildCollectionFormLocatorKey(params));
  }

  async readPrimaryCandidateRef(params: {
    corpId: string;
    userId: string;
    botUserId: string;
    jobId: number;
  }): Promise<string | null> {
    return this.readLocatorCandidateRef(buildCollectionFormPrimaryLocatorKey(params));
  }

  private async readLocatorCandidateRef(key: string): Promise<string | null> {
    const entry = await this.redis.get<CollectionFormStoreEntry>(key);
    const content = entry?.content;
    if (!content || typeof content !== 'object') return null;
    const candidateRef = (content as { candidateRef?: unknown }).candidateRef;
    return typeof candidateRef === 'string' && candidateRef.length > 0 ? candidateRef : null;
  }

  /** 整实体覆盖写（merge=false）：表单的写路径纯函数已产出完整新实体，deepMerge 只会把删掉的槽位又粘回来。 */
  async write(
    params: { corpId: string; userId: string; botUserId: string },
    form: BookingCollectionForm,
  ): Promise<void> {
    const formKey = buildCollectionFormKey({
      corpId: params.corpId,
      userId: params.userId,
      botUserId: params.botUserId,
      candidateRef: form.candidateRef,
      jobId: form.jobId,
    });
    const locatorKey = buildCollectionFormLocatorKey({
      corpId: params.corpId,
      userId: params.userId,
      botUserId: params.botUserId,
      jobId: form.jobId,
    });
    await this.writeSnapshot(formKey, form as unknown as Record<string, unknown>);
    await this.writeSnapshot(locatorKey, { candidateRef: form.candidateRef });
    if (form.candidateScope !== 'additional') {
      await this.writeSnapshot(
        buildCollectionFormPrimaryLocatorKey({ ...params, jobId: form.jobId }),
        { candidateRef: form.candidateRef },
      );
    }
  }

  async remove(params: {
    corpId: string;
    userId: string;
    botUserId: string;
    candidateRef: string;
    jobId: number;
  }): Promise<void> {
    await this.redis.del(buildCollectionFormKey(params));
    const [currentRef, primaryRef] = await Promise.all([
      this.readCurrentCandidateRef(params),
      this.readPrimaryCandidateRef(params),
    ]);
    if (currentRef === params.candidateRef) {
      await this.redis.del(buildCollectionFormLocatorKey(params));
    }
    if (primaryRef === params.candidateRef) {
      await this.redis.del(buildCollectionFormPrimaryLocatorKey(params));
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
