import { Global, Module } from '@nestjs/common';
import { HuajuneReporterService } from './huajune-reporter.service';

/**
 * 花卷招聘事件上报模块（写入侧）。
 *
 * @Global：HuajuneReporterService 当前无调用方（上报调用已全部移除），模块保留待用——
 * 重启只需加回 reportXxx 调用（fire-and-forget），@Global 便于届时任意触点直接注入。
 */
@Global()
@Module({
  providers: [HuajuneReporterService],
  exports: [HuajuneReporterService],
})
export class HuajuneModule {}
