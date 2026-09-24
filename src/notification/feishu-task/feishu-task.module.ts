import { Module } from '@nestjs/common';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { FeishuTaskClient } from './feishu-task.client';
import { InterventionTaskService } from './intervention-task.service';

/**
 * 人工介入 → 飞书任务模块（PRD R6）。
 *
 * 依赖：FeishuApiService / RedisService / HostingMemberConfigService / AlertNotifierService
 * 均由 @Global 模块提供；SystemConfigService（运行时开关）来自 HostingConfigModule；
 * LongTermService（面试时间）由 InterventionTaskService 在装配完成后经 ModuleRef 懒解析，
 * 避免把 MemoryModule 整块拖进来。
 */
@Module({
  imports: [HostingConfigModule],
  providers: [FeishuTaskClient, InterventionTaskService],
  exports: [FeishuTaskClient, InterventionTaskService],
})
export class FeishuTaskModule {}
