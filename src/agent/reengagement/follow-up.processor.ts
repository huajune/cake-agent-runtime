import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  ReengagementTrackingService,
  type ReengagementTouchIdentity,
} from '@biz/monitoring/services/tracking/reengagement-tracking.service';
import { SessionService } from '@memory/services/session.service';
import { CHANNEL_DELIVERY_PORT, type ChannelDeliveryPort } from './channel-delivery.port';
import { AgentRunnerService } from '../runner/agent-runner.service';
import type { TurnOutcome } from '../runner/agent-runner.types';
import { TurnOutcomeInterventionService } from '../runner/turn-outcome-intervention.service';
import { REENGAGEMENT_JOB_NAME, REENGAGEMENT_QUEUE, type FollowUpJob } from './reengagement.types';
import {
  computeFireAt,
  getScenario,
  inWindow,
  resolveDelayMs,
  resolveRolloutEnabled,
  shouldStop,
} from './scenario-registry';
import { TouchLedgerService } from './touch-ledger.service';

/**
 * 复聊 TaskProcessor：到点 → 代码校验停止条件 → 复用 runner（继承 guardrail/记忆/观测）→ 投递。
 *
 * 开关走 Dashboard 运行时配置（DB 动态读，即时生效）：`reengagementEnabled` 是急刹车——
 * 关闭后在途 job 到点直接丢弃；`reengagementShadow`（第一版必跑）走完 shouldStop +
 * runner.runTurn 但**不 deliver**，只记"本应发 X / 命中场景 Y / 停止原因 Z"。
 * ⚠️ shadow ≠ 无副作用：主动回合已 toolMode:'readonly' 物理禁副作用工具（见 runner.runTurn），
 * shadow 再叠加"不投递"，两者缺一不可。
 */
@Injectable()
export class FollowUpProcessor implements OnModuleInit {
  private readonly logger = new Logger(FollowUpProcessor.name);

  constructor(
    @InjectQueue(REENGAGEMENT_QUEUE) private readonly queue: Queue<FollowUpJob>,
    private readonly session: SessionService,
    private readonly runner: AgentRunnerService,
    private readonly touchLedger: TouchLedgerService,
    private readonly systemConfig: SystemConfigService,
    private readonly outcomeFinalizer: TurnOutcomeInterventionService,
    private readonly tracking: ReengagementTrackingService,
    @Optional()
    @Inject(CHANNEL_DELIVERY_PORT)
    private readonly delivery?: ChannelDeliveryPort<TurnOutcome>,
  ) {}

  onModuleInit(): void {
    this.queue.process(REENGAGEMENT_JOB_NAME, 2, (job: Job<FollowUpJob>) => this.process(job));
    this.logger.log(
      `[reengagement] processor 已注册（delivery=${this.delivery ? 'bound' : 'none'}，enabled/shadow 由运行时配置动态控制）`,
    );
  }

  async process(job: Job<FollowUpJob>): Promise<void> {
    const { sessionRef, scenarioCode, anchorAt, anchorEventId } = job.data;
    const scenario = getScenario(scenarioCode);
    if (!scenario) {
      this.logger.warn(`[reengagement] 未知场景 ${scenarioCode}，跳过`);
      return;
    }
    const identity: ReengagementTouchIdentity = {
      sessionId: sessionRef.sessionId,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      scenarioCode,
      anchorEventId,
      anchorAt,
    };

    // 0) 总开关急刹车：Dashboard 关闭后，在途 job 到点直接丢弃（不生成、不投递、不重排）
    const runtime = await this.systemConfig.getAgentReplyConfig();
    if (!runtime.reengagementEnabled) {
      this.logger.log(
        `[reengagement] 总开关关闭，丢弃到点任务 ${scenarioCode} sessionId=${sessionRef.sessionId}`,
      );
      this.tracking.trackDisabledAtFire(identity);
      return;
    }

    const now = Date.now();
    const state = await this.session.getAuthoritativeState(
      sessionRef.corpId,
      sessionRef.userId,
      sessionRef.sessionId,
    );

    // 1) 停止条件（代码，调 LLM 之前）
    const stop = shouldStop(scenario, state, anchorAt);
    if (stop.stop) {
      this.logger.log(
        `[reengagement] 停止 ${scenarioCode} sessionId=${sessionRef.sessionId} 原因=${stop.reason}`,
      );
      this.tracking.trackStopped(identity, stop.reason ?? 'stopped');
      return;
    }

    // 2) 频控：24h ≤ 2（只数 sent）
    if (await this.touchLedger.isOverFrequencyLimit(sessionRef.sessionId, now)) {
      this.logger.log(`[reengagement] 频控丢弃 ${scenarioCode} sessionId=${sessionRef.sessionId}`);
      this.tracking.trackFrequencyBlocked(identity);
      return;
    }

    // 3) 9-21 窗口二次确认（防 delay 漂移）；不在窗口 → 推到下一窗口
    if (!inWindow(now)) {
      await this.reschedule(job, scenario, state, anchorAt);
      return;
    }

    // 4) 投递 + 触达底账（shadow 只记不发）
    // 无投递端口绑定时强制 shadow；否则读运行时配置（与开头的总开关同一次读取）。
    // 所有未投递分支的 runTurnEnd 一律 includeAssistantText:false：候选人没收到这条文本，
    // 若照常投影成助手轮次，下一轮真实对话会引用一段候选人从未见过的"跟进"（HC-4 幽灵回复）。
    // 场景级灰度（Dashboard 可配）：场景开关 × 报名后大开关叠加
    const rolloutEnabled = resolveRolloutEnabled(scenario, runtime);
    const shadow = !this.delivery || runtime.reengagementShadow;
    if (shadow || !rolloutEnabled || !this.delivery) {
      const outcome = await this.runProactiveTurn(sessionRef, scenarioCode, scenario);
      this.logger.log(
        `[reengagement][SHADOW] 本应发: scenario=${scenarioCode} sessionId=${sessionRef.sessionId} ` +
          `text="${outcome.kind === 'reply' ? outcome.reply?.text.slice(0, 60) : `[${outcome.kind}]`}"` +
          `（shadow=${shadow}, rollout=${rolloutEnabled}）`,
      );
      this.tracking.trackShadow(identity, {
        outcomeKind: outcome.kind,
        generatedText: outcome.kind === 'reply' ? outcome.reply?.text : undefined,
        reason: !this.delivery
          ? 'no_delivery_port'
          : !rolloutEnabled
            ? 'rollout_disabled'
            : 'shadow_mode',
      });
      if (outcome.runTurnEnd) await outcome.runTurnEnd({ includeAssistantText: false });
      return;
    }

    const key = `${sessionRef.sessionId}:${scenarioCode}:${anchorAt}`;
    const slot = await this.touchLedger.reserve(key);
    if (slot === 'duplicate_sent') {
      // 之前那次触达已送达，但**本次生成的文本**没发出去——不投影本次文本。
      this.logger.log(`[reengagement] 已发过，跳过 key=${key}`);
      this.tracking.trackDuplicate(identity, slot);
      return;
    }
    if (slot === 'duplicate_inflight') {
      this.logger.warn(`[reengagement] 触达已在途/状态不明，跳过重投 key=${key}`);
      this.tracking.trackDuplicate(identity, slot);
      return;
    }
    this.tracking.trackReserved(identity);

    const outcome = await this.runProactiveTurn(sessionRef, scenarioCode, scenario);
    if (outcome.kind !== 'reply' || !outcome.reply) {
      this.logger.log(
        `[reengagement] 回合非 reply（${outcome.kind}）→ 不投递 ${scenarioCode} sessionId=${sessionRef.sessionId}`,
      );
      this.tracking.trackOutcomeNotReply(identity, outcome.kind);
      await this.outcomeFinalizer.commit(outcome, {
        traceId: key,
        chatId: sessionRef.sessionId,
        userId: sessionRef.userId,
        corpId: sessionRef.corpId,
        userMessage: `[系统主动跟进:${scenarioCode}]`,
      });
      await this.touchLedger.markFailedOrUnknown(key, 'failed');
      return;
    }

    await this.outboxDeliverReserved(outcome, key, sessionRef.sessionId, now, identity);
  }

  private runProactiveTurn(
    sessionRef: FollowUpJob['sessionRef'],
    scenarioCode: string,
    scenario: NonNullable<ReturnType<typeof getScenario>>,
  ): Promise<TurnOutcome> {
    const directive = `${scenario.objective}。生成要求：${scenario.generationPolicy}`;
    return this.runner.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive, scenarioCode },
      toolMode: 'readonly',
    });
  }

  /** outbox 状态机投递：reserved → attempted → sent / unknown。 */
  private async outboxDeliverReserved(
    outcome: TurnOutcome,
    key: string,
    sessionId: string,
    now: number,
    identity: ReengagementTouchIdentity,
  ): Promise<void> {
    try {
      await this.touchLedger.markDeliveryAttempted(key);
      this.tracking.trackDeliveryAttempted(identity);
      await this.delivery!.deliver(outcome, { idempotencyKey: key });
      await this.touchLedger.markSent(key, sessionId, now);
      this.tracking.trackSent(identity, outcome.reply?.text);
    } catch (error) {
      // deliver 后状态不明 → unknown，交补偿，不盲重投。送达与否未知时按未送达处理：
      // 宁可下一轮重复跟进语气，也不能让记忆引用候选人可能没收到的文本（HC-4）。
      this.tracking.trackDeliveryUnknown(identity, this.errorMessage(error));
      try {
        await this.touchLedger.markFailedOrUnknown(key, 'unknown');
      } finally {
        await outcome.runTurnEnd?.({ includeAssistantText: false });
      }
      throw error;
    }

    try {
      await outcome.runTurnEnd?.({ includeAssistantText: true });
    } catch (error) {
      this.logger.warn(
        `[reengagement] turn-end lifecycle 执行失败，不改写触达状态: key=${key}, error=${this.errorMessage(error)}`,
      );
    }
    this.logger.log(`[reengagement] 已投递 key=${key}`);
  }

  /** 不在窗口：推到下一个 9-21 窗口重排（不消费 attempts）。 */
  private async reschedule(
    job: Job<FollowUpJob>,
    scenario: ReturnType<typeof getScenario>,
    state: Parameters<typeof resolveDelayMs>[1]['state'],
    anchorAt: number,
  ): Promise<void> {
    if (!scenario) return;
    const nextAnchorAt = Math.max(Date.now(), anchorAt);
    const fireAt = computeFireAt(scenario, { anchorAt: nextAnchorAt, state });
    const delay = Math.max(0, fireAt - Date.now());
    const jobId = `${job.id}:rw:${fireAt}`;
    const rescheduledData: FollowUpJob = { ...job.data };
    await this.queue.add(REENGAGEMENT_JOB_NAME, rescheduledData, {
      jobId,
      delay,
      attempts: 2,
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: { age: 3 * 24 * 60 * 60, count: 200 },
      removeOnFail: { age: 3 * 24 * 60 * 60, count: 200 },
    });
    this.logger.log(
      `[reengagement] 非投递窗口，推迟到 ${new Date(fireAt).toISOString()} 重判 jobId=${job.id} rescheduledJobId=${jobId}`,
    );
    this.tracking.trackRescheduled(
      {
        sessionId: job.data.sessionRef.sessionId,
        userId: job.data.sessionRef.userId,
        corpId: job.data.sessionRef.corpId,
        scenarioCode: job.data.scenarioCode,
        anchorEventId: job.data.anchorEventId,
        anchorAt: job.data.anchorAt,
      },
      fireAt,
      jobId,
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
