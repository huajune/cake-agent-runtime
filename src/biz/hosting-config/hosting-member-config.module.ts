import { Global, Module } from '@nestjs/common';
import { HostingMemberConfigRepository } from './repositories/hosting-member-config.repository';
import { HostingMemberConfigService } from './services/hosting-member-config.service';

/**
 * 托管成员统一配置模块（飞书接收人 + 海绵 token，按 wecomUserId 索引）。
 *
 * @Global：飞书 notifier（notification/）、海绵 service（sponge/）等横切多处注入，
 * 全局可注入避免各模块重复 import + DI 环。依赖 SupabaseService / BotGroupResolverService 均为 @Global。
 */
@Global()
@Module({
  providers: [HostingMemberConfigRepository, HostingMemberConfigService],
  exports: [HostingMemberConfigService],
})
export class HostingMemberConfigModule {}
