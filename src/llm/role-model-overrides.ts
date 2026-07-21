/**
 * 角色模型运行时覆盖的依赖倒置接口。
 *
 * llm 层只定义契约，不依赖配置存储：实现方（biz/hosting-config 的
 * SystemConfigService 适配器）通过全局模块以 {@link ROLE_MODEL_OVERRIDES} token
 * 注入 LlmExecutorService。未提供实现时执行器行为不变（纯环境变量角色路由）。
 *
 * 优先级契约：调用方显式 modelId > 本覆盖（Dashboard 运行时配置）> AGENT_{ROLE}_MODEL。
 */
export const ROLE_MODEL_OVERRIDES = Symbol('ROLE_MODEL_OVERRIDES');

export interface RoleModelOverridesProvider {
  /** 返回该角色的运行时覆盖模型 ID；无覆盖返回 undefined（走环境变量角色路由）。 */
  getRoleModelOverride(role: string): Promise<string | undefined>;
}
