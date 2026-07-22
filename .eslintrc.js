module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['tsconfig.json', 'tests/tsconfig.json', 'scripts/tsconfig.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  overrides: [
    {
      // 旧路径收口：新代码禁止 import memory/facts/geo-mappings，一律改 @resolution/geo。
      // excludedFiles 是迁移期存量消费者豁免清单（§4 依赖盘点），Phase 2 逐边界迁移后清零；
      // 门面文件本身不 import 旧路径，无需豁免。
      files: ['src/**/*.ts'],
      excludedFiles: [
        'src/memory/facts/high-confidence-facts.ts',
        'src/memory/services/session.service.ts',
        'src/agent/generator/geocode-location-anchor.util.ts',
        'src/tools/duliday-job-list.tool.ts',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/facts/geo-mappings', '@memory/facts/geo-mappings'],
                message: '请从 @resolution/geo 导入（旧路径门面将于 Phase 5 删除，geo-domain-refactor-plan §12）',
              },
            ],
          },
        ],
      },
    },
    {
      // resolution 确定性解析层依赖隔离（geo-domain-refactor-plan v3.1 §12）：
      // 只允许被 memory/agent/tools/guardrail/infra 依赖，禁止反向依赖业务与基础设施。
      // brand 子域按现行规则可依赖 @sponge/*（品牌目录来自 SpongeService）。
      files: ['src/resolution/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@memory/*', '@/memory/*',
                  '@agent/*', '@/agent/*',
                  '@tools/*', '@/tools/*',
                  '@infra/*', '@/infra/*',
                  '@biz/*', '@/biz/*',
                  '@channels/*', '@/channels/*',
                  '@wecom/*',
                ],
                message: 'resolution 层禁止依赖业务/基础设施模块（geo-domain-refactor-plan §12）',
              },
            ],
          },
        ],
      },
    },
    {
      // geo 子域取零出向依赖："resolution 至多依赖 sponge" 是层级上限，geo 连 sponge 也不依赖。
      files: ['src/resolution/geo/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@memory/*', '@/memory/*',
                  '@agent/*', '@/agent/*',
                  '@tools/*', '@/tools/*',
                  '@infra/*', '@/infra/*',
                  '@biz/*', '@/biz/*',
                  '@channels/*', '@/channels/*',
                  '@wecom/*',
                  '@sponge/*', '@/sponge/*',
                  '@resolution/brand/*',
                ],
                message: 'resolution/geo 零出向依赖（geo-domain-refactor-plan §12）',
              },
            ],
          },
        ],
      },
    },
  ],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      },
    ],
  },
};
