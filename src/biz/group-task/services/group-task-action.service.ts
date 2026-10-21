import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import { identifyAction } from '@biz/action-execution/action-identity';
import type { ActionIntent, ActionSyncContext } from '@biz/action-execution/action-execution.types';
import {
  BOT_ACCOUNT_PROVIDER,
  type BotAccountProvider,
} from '@biz/ops-events/providers/bot-account.provider';
import { RedisService } from '@infra/redis/redis.service';
import { BrandRotationService } from './brand-rotation.service';
import { GroupTaskType } from '../group-task.types';
import {
  GROUP_TASK_QUEUE_NAME,
  GROUP_TASK_CACHE_TTL_SECONDS,
  GROUP_TASK_IDEMPOTENCY_TTL_SECONDS,
  groupTaskDailySentKey,
  groupTaskResultKey,
  type SendJobData,
  type GroupTaskMessageCache,
  type GroupTaskDispatchPlan,
} from '../queue/group-task-queue.constants';

export class GroupTaskDeferredError extends Error {
  constructor(readonly reason: string) {
    super(`group_task_deferred:${reason}`);
  }
}

interface Projection {
  jobId: string;
  execId: string;
  groupId: string;
  dailyKey: string;
  part: string;
  partIds: string[];
  groupKey: string;
  groupName: string;
  summary: string;
  brand?: string;
}

@Injectable()
export class GroupTaskActionService implements OnModuleInit {
  constructor(
    private readonly actions: ActionExecutorService,
    private readonly registry: ActionRecoveryRegistry,
    private readonly redis: RedisService,
    private readonly brands: BrandRotationService,
    private readonly config: ConfigService,
    @Inject(BOT_ACCOUNT_PROVIDER) private readonly bots: BotAccountProvider,
    @InjectQueue(GROUP_TASK_QUEUE_NAME) private readonly queue: Queue<SendJobData>,
  ) {}

  onModuleInit(): void {
    this.registry.register('group_task.message', {
      reconcile: async () => ({
        status: 'unknown',
        evidence: {
          kind: 'indeterminate',
          requestTerminated: false,
          detail: 'await_exact_provider_callback',
        },
      }),
      sync: async (record, context) => {
        await this.project(
          record.intent.recovery as unknown as Projection,
          record.actionId,
          context,
        );
        const job = await this.queue.getJob(String(record.intent.recovery?.jobId ?? ''));
        // Resume only the original task and immutable plan. No new intent or catch-up schedule.
        if (job && (await job.isFailed())) {
          await context?.assertOwned();
          await job.retry();
        }
      },
    });
  }

  async freezePlan(job: Job<SendJobData>, parts: GroupTaskDispatchPlan['parts']): Promise<void> {
    if (job.data.dispatchPlan) return;
    const group = job.data.group;
    const inputTime = job.data.startedAt ?? job.timestamp;
    const strict =
      this.config.get('ACTION_EXECUTION_MODE', 'observe') === 'execute' ||
      Boolean(this.config.get('ACTION_EXECUTION_CUTOVER_AT'));
    const account = (
      await this.bots.getConfiguredBotList().catch((error) => {
        if (strict) throw error;
        return [];
      })
    ).find((bot) => bot.wxid === group.imBotId);
    if ((!account?.corpId || !group.chatId || !Number.isFinite(inputTime)) && strict) {
      throw new GroupTaskDeferredError('missing_persisted_task_scope');
    }
    // Compatibility mode must keep the old API behavior when legacy tasks have incomplete scope.
    if (!account?.corpId || !group.chatId || !Number.isFinite(inputTime)) return;
    const planKey = `group-task:dispatch-plan:${job.data.execId}:${group.imRoomId}`;
    await this.redis.setNx(
      planKey,
      {
        corpId: account.corpId,
        logicalTurnId: `group-task:${job.data.execId}:${group.imRoomId}`,
        occurredAt: new Date(inputTime).toISOString(),
        parts,
      },
      GROUP_TASK_CACHE_TTL_SECONDS,
    );
    const frozen = await this.redis.get<GroupTaskDispatchPlan>(planKey);
    if (!frozen) throw new GroupTaskDeferredError('dispatch_plan_not_persisted');
    const data = {
      ...job.data,
      dispatchPlan: frozen,
    };
    await job.update(data);
    job.data = data;
  }

  async executePart(
    job: Job<SendJobData>,
    cache: GroupTaskMessageCache,
    part: GroupTaskDispatchPlan['parts'][number],
    dispatch: (requestId?: string) => Promise<void>,
    authorize: () => Promise<boolean>,
  ): Promise<void> {
    const plan = job.data.dispatchPlan;
    if (!plan) {
      await dispatch();
      return;
    }
    const { group, execId, type, execDate, timeSlot, groupKey } = job.data;
    const dailyKey = groupTaskDailySentKey(type, execDate, timeSlot, group.imRoomId);
    const projection: Projection = {
      jobId: String(job.id),
      execId,
      groupId: group.imRoomId,
      dailyKey,
      part: part.id,
      partIds: plan.parts.map((p) => p.id),
      groupKey,
      groupName: group.groupName,
      summary: cache.summary,
      ...(type === GroupTaskType.PART_TIME_JOB && cache.brand ? { brand: cache.brand } : {}),
    };
    const intent: ActionIntent = {
      corpId: plan.corpId,
      accountId: group.imBotId,
      chatId: group.chatId!,
      logicalTurnId: plan.logicalTurnId,
      intentId: `${dailyKey}:${part.id}`,
      kind: 'group_task.message',
      target: `group-message:${group.imRoomId}:${part.id}`,
      parameters: { messageType: part.messageType, payload: part.payload },
      occurredAt: plan.occurredAt,
      identityReliable: true,
      recovery: projection as unknown as Record<string, unknown>,
    };
    const result = await this.actions.execute(intent, {
      authorize: async () => {
        if (!(await authorize())) return false;
        const strict =
          this.config.get('ACTION_EXECUTION_MODE', 'observe') === 'execute' ||
          Boolean(this.config.get('ACTION_EXECUTION_CUTOVER_AT'));
        if (!strict) return true;
        if (Date.now() - Date.parse(plan.occurredAt) >= 24 * 3600_000) return false;
        const current = await this.bots.getConfiguredBotList();
        return current.some((bot) => bot.wxid === group.imBotId && bot.corpId === plan.corpId);
      },
      dispatch: async (requestId, mode) => {
        await dispatch(mode === 'execute' ? requestId : undefined);
        return mode === 'execute'
          ? { status: 'executing', evidence: { kind: 'accepted', requestTerminated: false } }
          : {
              status: 'succeeded',
              result: { sent: true },
              evidence: { kind: 'completed', requestTerminated: true },
            };
      },
      sync: async () => this.project(projection, identifyAction(intent).actionId),
    });
    if (result.status !== 'succeeded')
      throw new GroupTaskDeferredError(result.reason ?? result.status);
    // External success stays success even if projection is pending; recovery repairs it.
  }

  private async project(
    projection: Projection,
    actionId: string,
    context?: ActionSyncContext,
  ): Promise<void> {
    await context?.assertOwned();
    await this.redis.setex(
      `${projection.dailyKey}:part:${projection.part}`,
      GROUP_TASK_IDEMPOTENCY_TTL_SECONDS,
      '1',
    );
    for (const part of projection.partIds) {
      if (!(await this.redis.exists(`${projection.dailyKey}:part:${part}`))) return;
    }
    await context?.assertOwned();
    if (projection.brand)
      await this.brands.recordPushedBrandOnce(
        projection.groupId,
        projection.brand,
        `${projection.dailyKey}:brand`,
      );
    await context?.assertOwned();
    await this.redis.setex(projection.dailyKey, GROUP_TASK_IDEMPOTENCY_TTL_SECONDS, '1');
    await context?.assertOwned();
    await this.redis.setex(
      groupTaskResultKey(projection.execId, projection.groupId),
      GROUP_TASK_CACHE_TTL_SECONDS,
      {
        groupKey: projection.groupKey,
        groupName: projection.groupName,
        status: 'sent',
        summary: projection.summary,
        updatedAt: Date.now(),
        actionId,
      },
    );
  }
}
