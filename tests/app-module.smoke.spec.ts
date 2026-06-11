import { Test } from '@nestjs/testing';

/**
 * AppModule 全量装配冒烟测试 — 防 DI 死锁/断裂回归。
 *
 * 背景（v5.14.0 生产事故，PR #304）：构造期的 provider 级循环依赖会让
 * Nest 实例加载静默挂起——无报错、事件循环空转，只有真实装配一次完整
 * 依赖图才能暴露。常规单测全部 mock DI，CI 一路绿灯直到生产部署才失败。
 *
 * 本测试只做 compile()（实例化全部 provider，不触发 onModuleInit 等
 * 生命周期钩子，因此不会发起外部连接）；死锁表现为用例超时失败。
 */

/** CI 环境无 .env.local，为 env.validation 必填项与各客户端构造器提供哑值（不覆盖已有值）。 */
const SMOKE_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '8585',
  STRIDE_API_BASE_URL: 'https://stride.smoke.invalid',
  STRIDE_ENTERPRISE_API_BASE_URL: 'https://stride-ent.smoke.invalid',
  STRIDE_ENTERPRISE_TOKEN: 'smoke-test-token',
  AGENT_CHAT_MODEL: 'anthropic/claude-sonnet-4-5-20250929',
  UPSTASH_REDIS_REST_URL: 'https://dummy-redis.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'smoke-test-token',
  DULIDAY_API_TOKEN: 'smoke-test-token',
  ANTHROPIC_API_KEY: 'sk-ant-smoke-test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://dummy.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'smoke-test-key',
  FEISHU_ALERT_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/smoke-dummy',
  FEISHU_ALERT_SECRET: 'smoke-test-secret',
};

describe('AppModule 装配冒烟', () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(SMOKE_ENV_DEFAULTS)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });

  it('完整依赖图可实例化（DI 循环依赖会导致本用例超时，缺失依赖会直接报错）', async () => {
    const { AppModule } = await import('@/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 90_000);
});
