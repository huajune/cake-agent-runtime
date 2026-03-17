import type { JestConfigWithTsJest } from 'ts-jest';

const config: JestConfigWithTsJest = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/tests'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
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
            '@biz/*': ['src/biz/*'],
            '@providers/*': ['src/providers/*'],
            '@tools/*': ['src/tools/*'],
            '@memory/*': ['src/memory/*'],
            '@mcp/*': ['src/mcp/*'],
            '@sponge/*': ['src/sponge/*'],
            '@observability/*': ['src/observability/*'],
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
    '^@biz/(.*)$': '<rootDir>/src/biz/$1',
    '^@providers/(.*)$': '<rootDir>/src/providers/$1',
    '^@tools/(.*)$': '<rootDir>/src/tools/$1',
    '^@memory/(.*)$': '<rootDir>/src/memory/$1',
    '^@mcp/(.*)$': '<rootDir>/src/mcp/$1',
    '^@sponge/(.*)$': '<rootDir>/src/sponge/$1',
    '^@observability/(.*)$': '<rootDir>/src/observability/$1',
    '^@shared-types/(.*)$': '<rootDir>/src/types/$1',
  },
};

export default config;
