import { Global, Module } from '@nestjs/common';
import { SpongeModule } from '@sponge/sponge.module';
import { OpsEventsRecorderService } from './ops-events-recorder.service';
import { OpsEventsRepository } from './ops-events.repository';
import { BotGroupResolverService } from './bot-group-resolver.service';
import { SpongeStatusPollService } from './sponge-status-poll.cron';
import { DailyOpsReportRepository } from './daily-ops-report.repository';
import { OpsDailyReportCronService } from './ops-daily-report.cron';

/**
 * 运营事件底账模块（写入侧）。
 *
 * 标记 @Global：OpsEventsRecorderService 是横切关注点，被工具、消息管道、handoff、
 * cron 等多处调用，全局可注入避免每个模块重复 import（与 SupabaseModule / Redis 同理）。
 *
 * imports SpongeModule：SpongeStatusPollService 轮询海绵工单状态补记 interview.passed/hired。
 *
 * 托管 bot 账号列表通过 BOT_ACCOUNT_PROVIDER 令牌注入（依赖倒置，见 bot-account.provider.ts），
 * 由 @Global 的 BotModule 绑定到 wecom 的 BotService —— 故本模块不再 import channels/wecom。
 */
@Global()
@Module({
  imports: [SpongeModule],
  providers: [
    OpsEventsRepository,
    OpsEventsRecorderService,
    BotGroupResolverService,
    SpongeStatusPollService,
    DailyOpsReportRepository,
    OpsDailyReportCronService,
  ],
  exports: [OpsEventsRecorderService, BotGroupResolverService, DailyOpsReportRepository],
})
export class OpsEventsModule {}
