import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { MonitoringRecordRepository } from '../../repositories/record.repository';

/**
 * 语义评审覆盖率看门狗。
 *
 * 判据刻意做成确定性的：按整点小时统计「成功回合数 ≥ 阈值 **且** 语义评审落库数 = 0」，
 * 命中即飞书告警。硬规则命中仍会写 guardrail_review_records，所以只能数带语义评审的行——
 * 数总行数会被硬规则掩盖，无法发现语义评审的静默停摆。
 *
 * 只查上一个完整小时，两条带时间窗的聚合 count，不扫全表。
 */
@Injectable()
export class SemanticReviewCoverageWatchdog {
  private readonly logger = new Logger(SemanticReviewCoverageWatchdog.name);

  /**
   * 小时成功回合数低于该值时不判定——夜间/周末低峰期本来就可能一小时零评审，
   * 按低峰量能告警只会训练出「狼来了」。
   */
  private readonly minTurnsForAlert = 30;

  constructor(
    private readonly recordRepository: MonitoringRecordRepository,
    private readonly guardrailReviewService: GuardrailReviewService,
    private readonly alertService: AlertNotifierService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  /** 每小时第 5 分钟检查上一个完整小时，给异步追加的语义评审留出落库余量。 */
  @Cron('5 * * * *', { timeZone: 'Asia/Shanghai' })
  async checkPreviousHourCoverage(): Promise<void> {
    if (this.configService.get<string>('READ_ONLY_PREVIEW') === 'true') return;

    // 语义档被运营在 Dashboard 有意关停（shadow 与 enforce 均关）时，评审归零是
    // 期望状态而非停摆——每小时误报一次恰是本判据自称要避免的"狼来了"。开关读取
    // 失败按开启处理：宁可多查一轮，不能因配置抖动漏掉真停摆。
    try {
      const replyConfig = await this.systemConfigService.getAgentReplyConfig();
      if (
        !replyConfig.outputGuardrailLlmEnabled &&
        !replyConfig.outputGuardrailSemanticShadowEnabled
      ) {
        return;
      }
    } catch {
      // 继续检查
    }

    const to = new Date();
    to.setMinutes(0, 0, 0);
    const from = new Date(to.getTime() - 60 * 60 * 1000);

    try {
      const successfulTurns = await this.recordRepository.countSuccessfulTurnsBetween(from, to);
      if (successfulTurns < this.minTurnsForAlert) return;

      const semanticReviews = await this.guardrailReviewService.countSemanticReviewsBetween(
        from,
        to,
      );
      if (semanticReviews > 0) return;

      const window = `${this.formatHour(from)} - ${this.formatHour(to)}`;
      this.logger.error(
        `[语义评审看门狗] ${window} 成功回合 ${successfulTurns}，语义评审落库 0，疑似评审链路停摆`,
      );
      await this.alertService.sendSimpleAlert(
        '语义评审疑似停摆',
        [
          `窗口：${window}（CST）`,
          `该小时成功回合：${successfulTurns}`,
          '该小时语义评审落库：0',
          '',
          '出站语义 shadow 评审在整点小时内零产出，而回合量正常——大概率是评审链路整体降级，',
          '不是质量变好。该窗口的 badcase 不会被生成，任何「未复发/已归零」的结论都不成立。',
          '排查顺序：最近一次发版（尤其 LLM SDK 升级）→ semantic reviewer 模型配置 → provider 可用性。',
        ].join('\n'),
        AlertLevel.ERROR,
      );
    } catch (error) {
      this.logger.error(`[语义评审看门狗] 检查失败: ${toErrorMessage(error)}`);
    }
  }

  private formatHour(date: Date): string {
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
}
