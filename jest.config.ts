import type { JestConfigWithTsJest } from 'ts-jest';

const config: JestConfigWithTsJest = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/tests'],
  testRegex: '.*\\.spec\\.ts$',
  // AppModule 装配冒烟测试实例化真实 Bull/ioredis 客户端，遗留重连句柄会让
  // 默认全量跑挂住；它由专用配置 jest.di-smoke.config.ts（--forceExit）单独执行。
  testPathIgnorePatterns: ['<rootDir>/tests/app-module.smoke.spec.ts'],
  // ai@7 / @ai-sdk/* / @openrouter 自 v7 线起为纯 ESM 包；jest 29 的 CJS 运行时
  // 无法直接 require，必须让 ts-jest 把它们转译成 CJS（pnpm 布局下真实路径在
  // node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/，两段都要豁免）。
  transformIgnorePatterns: [
    '/node_modules/(?!\\.pnpm|ai/|@ai-sdk/|@openrouter/|@workflow/|eventsource-parser)',
    '/node_modules/\\.pnpm/(?!(ai@|@ai-sdk\\+|@openrouter\\+|@workflow\\+|eventsource-parser@))',
  ],
  transform: {
    // node_modules 里被豁免的 ESM 包走带 allowJs 的 ts-jest 转译成 CJS；
    // 项目自身的 scripts/*.js（含 shebang）保持默认条目原样通过，不能开 allowJs。
    '[/\\\\]node_modules[/\\\\].+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: { allowJs: true },
      },
    ],
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: {
          baseUrl: '.',
          paths: {
            '@/*': ['src/*'],
            '@infra/*': ['src/infra/*'],
            '@agent/*': ['src/agent/*'],
            '@channels': ['src/channels'],
            '@channels/*': ['src/channels/*'],
            '@wecom': ['src/channels/wecom'],
            '@wecom/*': ['src/channels/wecom/*'],
            '@enums/*': ['src/enums/*'],
            '@test-suite/*': ['src/biz/test-suite/*'],
            '@evaluation/*': ['src/evaluation/*'],
            '@biz/*': ['src/biz/*'],
            '@providers/*': ['src/providers/*'],
            '@tools/*': ['src/tools/*'],
            '@memory/*': ['src/memory/*'],
            '@mcp/*': ['src/mcp/*'],
            '@sponge/*': ['src/sponge/*'],
            '@resolution/*': ['src/resolution/*'],
            '@observability/*': ['src/observability/*'],
            '@notification/*': ['src/notification/*'],
            '@analytics/*': ['src/analytics/*'],
            '@shared-types/*': ['src/types/*'],
          },
        },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  preset: 'ts-jest',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@infra/(.*)$': '<rootDir>/src/infra/$1',
    '^@agent/(.*)$': '<rootDir>/src/agent/$1',
    '^@channels$': '<rootDir>/src/channels',
    '^@channels/(.*)$': '<rootDir>/src/channels/$1',
    '^@wecom$': '<rootDir>/src/channels/wecom',
    '^@wecom/(.*)$': '<rootDir>/src/channels/wecom/$1',
    '^@enums/(.*)$': '<rootDir>/src/enums/$1',
    '^@test-suite/(.*)$': '<rootDir>/src/biz/test-suite/$1',
    '^@evaluation/(.*)$': '<rootDir>/src/evaluation/$1',
    '^@biz/(.*)$': '<rootDir>/src/biz/$1',
    '^@providers/(.*)$': '<rootDir>/src/providers/$1',
    '^@tools/(.*)$': '<rootDir>/src/tools/$1',
    '^@memory/(.*)$': '<rootDir>/src/memory/$1',
    '^@mcp/(.*)$': '<rootDir>/src/mcp/$1',
    '^@sponge/(.*)$': '<rootDir>/src/sponge/$1',
    '^@resolution/(.*)$': '<rootDir>/src/resolution/$1',
    '^@observability/(.*)$': '<rootDir>/src/observability/$1',
    '^@notification/(.*)$': '<rootDir>/src/notification/$1',
    '^@analytics/(.*)$': '<rootDir>/src/analytics/$1',
    '^@shared-types/(.*)$': '<rootDir>/src/types/$1',
  },
};

export default config;
