import { Global, Module } from '@nestjs/common';
import { HuajuneReporterService } from './huajune-reporter.service';

/**
 * 花卷招聘事件上报模块（写入侧）。
 *
 * @Global：HuajuneReporterService 被预约工具、消息管道等多处调用（fire-and-forget）。
 */
@Global()
@Module({
  providers: [HuajuneReporterService],
  exports: [HuajuneReporterService],
})
export class HuajuneModule {}
