import type { JestConfigWithTsJest } from 'ts-jest';

const config: JestConfigWithTsJest = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
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
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  preset: 'ts-jest',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@core/http$': '<rootDir>/core/client-http',
    '^@core/response$': '<rootDir>/core/response',
    '^@core$': '<rootDir>/core',
    '^@core/(.*)$': '<rootDir>/core/$1',
    '^@agent$': '<rootDir>/agent',
    '^@agent/(.*)$': '<rootDir>/agent/$1',
    '^@wecom$': '<rootDir>/wecom',
    '^@wecom/(.*)$': '<rootDir>/wecom/$1',
    '^@shared$': '<rootDir>/shared',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
    '^@test-suite$': '<rootDir>/biz/test-suite',
    '^@test-suite/(.*)$': '<rootDir>/biz/test-suite/$1',
    '^@core/supabase$': '<rootDir>/core/supabase',
    '^@biz/(.*)$': '<rootDir>/biz/$1',
    '^@ai$': '<rootDir>/ai',
    '^@ai/(.*)$': '<rootDir>/ai/$1',
  },
};

export default config;
