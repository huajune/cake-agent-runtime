import { Global, Module } from '@nestjs/common';
import { ROLE_MODEL_OVERRIDES, type RoleModelOverridesProvider } from '@/llm/role-model-overrides';
import { HostingConfigModule } from './hosting-config.module';
import { SystemConfigService } from './services/system-config.service';

/**
 * 角色模型运行时覆盖的全局装配模块。
 *
 * llm 层只认 {@link ROLE_MODEL_OVERRIDES} 契约（依赖倒置，llm 不 import biz）；
 * 这里用 SystemConfigService 适配实现并 @Global 导出，LlmExecutorService 的
 * @Optional 注入在任何模块上下文都能拿到。单测/脚本环境不导入本模块时，
 * 执行器自动退回纯环境变量角色路由。
 */
@Global()
@Module({
  imports: [HostingConfigModule],
  providers: [
    {
      provide: ROLE_MODEL_OVERRIDES,
      useFactory: (systemConfig: SystemConfigService): RoleModelOverridesProvider => ({
        getRoleModelOverride: (role) => systemConfig.getRoleModelOverride(role),
      }),
      inject: [SystemConfigService],
    },
  ],
  exports: [ROLE_MODEL_OVERRIDES],
})
export class RoleModelOverridesModule {}
