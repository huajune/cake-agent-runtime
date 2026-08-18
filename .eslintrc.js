module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['tsconfig.json', 'tests/tsconfig.json', 'scripts/tsconfig.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  overrides: [
    // 旧路径 memory/facts/geo-mappings 的 no-restricted-imports 规则已随门面删除
    // 一并移除（Phase 5 收口，geo-domain-refactor-plan §12：门面删除后此条随文件消失）。
    {
      // resolution 确定性解析层依赖隔离（geo-domain-refactor-plan v3.1 §12）：
      // 只允许被 memory/agent/tools/guardrail/infra 依赖，禁止反向依赖业务与基础设施。
      // brand 子域按现行规则可依赖 @sponge/*（品牌目录来自 SpongeService）。
      // resolution 仅保留 `@infra/utils/date.util` 窄例外（规则轨按业务时区解释日期）。
      // 消息标记协议已归 `resolution/signal/markers`；string/object/fetch-timeout 以及
      // infra 其余子目录均不对 resolution 放行。
      files: ['src/resolution/**/*.ts'],
      rules: {
        'no-restricted-syntax': 'off',
        'no-restricted-imports': 'off',
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@agent/*',
                  '@/agent/*',
                  '@tools/*',
                  '@/tools/*',
                  '@infra/*',
                  '@/infra/*',
                  '!@infra/utils',
                  '!@/infra/utils',
                  '@infra/utils/*',
                  '@/infra/utils/*',
                  '!@infra/utils/date.util',
                  '!@/infra/utils/date.util',
                  '@biz/*',
                  '@/biz/*',
                  '@channels/*',
                  '@/channels/*',
                  '@wecom/*',
                ],
                message:
                  'resolution 层禁止依赖业务/基础设施模块（仅 @infra/utils/date.util 窄例外）',
              },
              {
                // PR #1000 评审 P3：type-only 豁免已无使用者，且与 CLAUDE.md 的
                // 「resolution 至多依赖 sponge 与 infra/utils/date.util」矛盾，收紧为全禁。
                group: ['@memory/*', '@/memory/*'],
                message: 'resolution 禁止依赖 memory（memory 消费 resolution，不得反向）',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/memory/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@tools/*', '@/tools/*'],
                message: 'memory 禁止依赖 tools（候选人档案域宪法 P1）',
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
                  '@memory/*',
                  '@/memory/*',
                  '@agent/*',
                  '@/agent/*',
                  '@tools/*',
                  '@/tools/*',
                  '@infra/*',
                  '@/infra/*',
                  '@biz/*',
                  '@/biz/*',
                  '@channels/*',
                  '@/channels/*',
                  '@wecom/*',
                  '@sponge/*',
                  '@/sponge/*',
                  '@resolution/brand/*',
                ],
                message: 'resolution/geo 零出向依赖（geo-domain-refactor-plan §12）',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/infra/utils/error.util.ts'],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
    {
      // 并发避让：这两份文件由另一会话修改，本提交不得触碰；后续单独清扫后移除豁免。
      files: [
        'src/agent/generator/preparation.service.ts',
        'src/tools/duliday-interview-booking.tool.ts',
      ],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error']",
        message:
          '用 @infra/utils/error.util 的 toErrorMessage / toErrorStack（resolution 层除外，见 §0.1）',
      },
    ],
  },
};
