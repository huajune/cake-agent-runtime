import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { SessionService } from '@memory/services/session.service';
import { CHANNEL_DELIVERY_PORT, type ChannelDeliveryPort } from '../ports/channel-delivery.port';
import { TurnRunnerService } from '../runner/turn-runner.service';
import type { TurnOutcome } from '../runner/turn-runner.types';
import { REENGAGEMENT_JOB_NAME, REENGAGEMENT_QUEUE, type FollowUpJob } from './reengagement.types';
import {
  computeFireAt,
  getScenario,
  inWindow,
  resolveDelayMs,
  shouldStop,
} from './scenario-registry';
import { TouchLedgerService } from './touch-ledger.service';

/**
 * 复聊 TaskProcessor：到点 → 代码校验停止条件 → 复用 runner（继承 guardrail/记忆/观测）→ 投递。
 *
 * Shadow（第一版必跑）：REENGAGEMENT_SHADOW=true 时走完 shouldStop + runner.runTurn 但**不 deliver**，
 * 只记"本应发 X / 命中场景 Y / 停止原因 Z"。⚠️ shadow ≠ 无副作用：主动回合已 toolMode:'readonly'
 * 物理禁副作用工具（见 runner.runTurn），shadow 再叠加"不投递"，两者缺一不可。
 */
@Injectable()
export class FollowUpProcessor implements OnModuleInit {
  private readonly logger = new Logger(FollowUpProcessor.name);

  constructor(
    @InjectQueue(REENGAGEMENT_QUEUE) private readonly queue: Queue<FollowUpJob>,
    private readonly session: SessionService,
    private readonly runner: TurnRunnerService,
    private readonly touchLedger: TouchLedgerService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(CHANNEL_DELIVERY_PORT)
    private readonly delivery?: ChannelDeliveryPort<TurnOutcome>,
  ) {}

  onModuleInit(): void {
    this.queue.process(REENGAGEMENT_JOB_NAME, 2, (job: Job<FollowUpJob>) => this.process(job));
    this.logger.log(
      `[reengagement] processor 已注册（shadow=${this.isShadow()}, delivery=${this.delivery ? 'bound' : 'none'}）`,
    );
  }

  private isShadow(): boolean {
    // 默认 shadow（只排程不发），且无投递端口绑定时强制 shadow
    if (!this.delivery) return true;
    return this.configService.get<string>('REENGAGEMENT_SHADOW', 'true') !== 'false';
  }

  async process(job: Job<FollowUpJob>): Promise<void> {
    const { sessionRef, scenarioCode, anchorAt } = job.data;
    const scenario = getScenario(scenarioCode);
    if (!scenario) {
      this.logger.warn(`[reengagement] 未知场景 ${scenarioCode}，跳过`);
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
      return;
    }

    // 2) 频控：24h ≤ 2（只数 sent）
    if (await this.touchLedger.isOverFrequencyLimit(sessionRef.sessionId, now)) {
      this.logger.log(`[reengagement] 频控丢弃 ${scenarioCode} sessionId=${sessionRef.sessionId}`);
      return;
    }

    // 3) 9-21 窗口二次确认（防 delay 漂移）；不在窗口 → 推到下一窗口
    if (!inWindow(now)) {
      await this.reschedule(job, scenario, state, anchorAt);
      return;
    }

    // 4) 复用 runner 构造主动回合（toolMode:'readonly' 物理禁副作用）
    const directive = `${scenario.objective}。生成要求：${scenario.generationPolicy}`;
    const outcome = await this.runner.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive, scenarioCode },
      toolMode: 'readonly',
    });

    // 5) 投递 + 触达底账（shadow 只记不发）
    if (outcome.kind !== 'reply' || !outcome.reply) {
      this.logger.log(
        `[reengagement] 回合非 reply（${outcome.kind}）→ 不投递 ${scenarioCode} sessionId=${sessionRef.sessionId}`,
      );
      if (outcome.runTurnEnd) await outcome.runTurnEnd();
      return;
    }

    const shadow = this.isShadow();
    if (shadow || !scenario.rolloutEnabled || !this.delivery) {
      this.logger.log(
        `[reengagement][SHADOW] 本应发: scenario=${scenarioCode} sessionId=${sessionRef.sessionId} ` +
          `text="${outcome.reply.text.slice(0, 60)}"（shadow=${shadow}, rollout=${scenario.rolloutEnabled}）`,
      );
      if (outcome.runTurnEnd) await outcome.runTurnEnd();
      return;
    }

    await this.outboxDeliver(outcome, sessionRef.sessionId, scenarioCode, anchorAt, now);
  }

  /** outbox 状态机投递：reserve → attempted → sent / unknown。 */
  private async outboxDeliver(
    outcome: TurnOutcome,
    sessionId: string,
    scenarioCode: string,
    anchorAt: number,
    now: number,
  ): Promise<void> {
    const key = `${sessionId}:${scenarioCode}:${anchorAt}`;
    const slot = await this.touchLedger.reserve(key);
    if (slot === 'duplicate_sent') {
      this.logger.log(`[reengagement] 已发过，跳过 key=${key}`);
      if (outcome.runTurnEnd) await outcome.runTurnEnd();
      return;
    }
    if (slot === 'duplicate_inflight') {
      this.logger.warn(`[reengagement] 触达已在途/状态不明，跳过重投 key=${key}`);
      if (outcome.runTurnEnd) await outcome.runTurnEnd();
      return;
    }
    try {
      await this.touchLedger.markDeliveryAttempted(key);
      await this.delivery!.deliver(outcome, { idempotencyKey: key });
      await this.touchLedger.markSent(key, sessionId, now);
      if (outcome.runTurnEnd) await outcome.runTurnEnd();
      this.logger.log(`[reengagement] 已投递 key=${key}`);
    } catch (error) {
      // deliver 后状态不明 → unknown，交补偿，不盲重投
      try {
        await this.touchLedger.markFailedOrUnknown(key, 'unknown');
      } finally {
        if (outcome.runTurnEnd) await outcome.runTurnEnd();
      }
      throw error;
    }
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
  }
}
