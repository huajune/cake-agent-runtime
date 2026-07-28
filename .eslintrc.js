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
