import type { JestConfigWithTsJest } from 'ts-jest';
import baseConfig from './jest.config';

/**
 * AppModule 装配冒烟测试专用配置（pnpm run test:di-smoke）。
 *
 * 与主配置分离的原因：冒烟测试实例化真实 BullQueueModule，ioredis 的
 * 重连定时器在 moduleRef.close() 后仍存活，需要 --forceExit（写在 npm
 * script 里）收尾；放进默认全量跑会让 jest 挂住。
 */
const config: JestConfigWithTsJest = {
  ...baseConfig,
  testRegex: 'app-module\\.smoke\\.spec\\.ts$',
  testPathIgnorePatterns: [],
  collectCoverage: false,
};

export default config;
