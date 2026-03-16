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
            '@core': ['src/core'],
            '@core/*': ['src/core/*'],
            '@core/http': ['src/core/client-http'],
            '@core/response': ['src/core/response'],
            '@agent': ['src/agent'],
            '@agent/*': ['src/agent/*'],
            '@wecom': ['src/wecom'],
            '@wecom/*': ['src/wecom/*'],
            '@shared': ['src/shared'],
            '@shared/*': ['src/shared/*'],
            '@test-suite': ['src/biz/test-suite'],
            '@test-suite/*': ['src/biz/test-suite/*'],
            '@core/supabase': ['src/core/supabase'],
            '@biz/*': ['src/biz/*'],
            '@ai': ['src/ai'],
            '@ai/*': ['src/ai/*'],
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
    '^@core/http$': '<rootDir>/src/core/client-http',
    '^@core/response$': '<rootDir>/src/core/response',
    '^@core$': '<rootDir>/src/core',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@agent$': '<rootDir>/src/agent',
    '^@agent/(.*)$': '<rootDir>/src/agent/$1',
    '^@wecom$': '<rootDir>/src/wecom',
    '^@wecom/(.*)$': '<rootDir>/src/wecom/$1',
    '^@shared$': '<rootDir>/src/shared',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@test-suite$': '<rootDir>/src/biz/test-suite',
    '^@test-suite/(.*)$': '<rootDir>/src/biz/test-suite/$1',
    '^@core/supabase$': '<rootDir>/src/core/supabase',
    '^@biz/(.*)$': '<rootDir>/src/biz/$1',
    '^@ai$': '<rootDir>/src/ai',
    '^@ai/(.*)$': '<rootDir>/src/ai/$1',
  },
};

export default config;
