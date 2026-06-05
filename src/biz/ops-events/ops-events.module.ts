import { Global, Module } from '@nestjs/common';
import { SpongeModule } from '@sponge/sponge.module';
import { BotModule } from '@channels/wecom/bot/bot.module';
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
 */
@Global()
@Module({
  imports: [SpongeModule, BotModule],
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
