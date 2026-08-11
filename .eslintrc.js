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
    // 旧路径 memory/facts/geo-mappings 的 no-restricted-imports 规则已随门面删除
    // 一并移除（Phase 5 收口，geo-domain-refactor-plan §12：门面删除后此条随文件消失）。
    {
      // resolution 确定性解析层依赖隔离（geo-domain-refactor-plan v3.1 §12）：
      // 只允许被 memory/agent/tools/guardrail/infra 依赖，禁止反向依赖业务与基础设施。
      // brand 子域按现行规则可依赖 @sponge/*（品牌目录来自 SpongeService）。
      // 2026-08-07 放宽一处：`@infra/utils/*` 是零依赖纯函数抽屉（date/string/object/
      // message-markup），本身不 import 任何业务模块，属层级最底。visual 子域判定视觉
      // 消息必须先认标记（`[图片消息]` 前缀等），而标记协议的唯一居所在那里——不放行
      // 就只能在域内复刻一份正则，正是本次收口要消灭的东西。infra 其余子目录（服务、
      // 配置、客户端）仍全禁。
      files: ['src/resolution/**/*.ts'],
      rules: {
        'no-restricted-imports': 'off',
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@agent/*', '@/agent/*',
                  '@tools/*', '@/tools/*',
                  '@infra/*', '@/infra/*',
                  '!@infra/utils', '!@/infra/utils',
                  '!@infra/utils/**', '!@/infra/utils/**',
                  '@biz/*', '@/biz/*',
                  '@channels/*', '@/channels/*',
                  '@wecom/*',
                ],
                message: 'resolution 层禁止依赖业务/基础设施模块（@infra/utils/* 纯函数除外，geo-domain-refactor-plan §12）',
              },
              {
                group: ['@memory/*', '@/memory/*'],
                allowTypeImports: true,
                message: 'resolution 只允许 type-only 引用 memory 存储契约，禁止运行时反向依赖',
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
      files: ['src/tools/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@memory/facts/*', '@/memory/facts/*'],
                message: 'tools 禁止依赖 memory/facts（候选人档案域宪法 P2）；服务经 DI',
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
