# 分支保护规则配置指南

## 📋 概述

本文档指导如何配置 GitHub 分支保护规则，确保所有 PR 必须通过 CI 检查后才能合并到主要分支。

## 🎯 保护目标

配置以下分支的保护规则：
- `master` - 生产分支
- `develop` - 开发分支

## 🔧 配置步骤

### 1. 进入仓库设置

1. 打开 GitHub 仓库页面
2. 点击 **Settings** (设置)
3. 在左侧菜单中找到 **Branches** (分支)

### 2. 添加分支保护规则

点击 **Add branch protection rule** (添加分支保护规则)

### 3. 配置保护规则

#### 基础配置

**Branch name pattern** (分支名称模式):
```
develop
```

推荐分别为以下分支创建保护规则:
```
master
develop
```

#### 必需的检查项

勾选以下选项：

✅ **Require a pull request before merging**
   - 要求通过 PR 才能合并
   - 推荐配置：
     - ✅ Require approvals: 1 (至少需要 1 人审批)
     - ✅ Dismiss stale pull request approvals when new commits are pushed (新提交时取消旧的审批)

✅ **Require status checks to pass before merging**
   - 要求状态检查通过后才能合并
   - ✅ Require branches to be up to date before merging (要求分支为最新)

   **Status checks that are required** (必需通过的检查):
   - ✅ `代码质量检查` (lint-and-format)
   - ✅ `TypeScript 类型检查` (type-check)
   - ✅ `构建检查` (build)
   - ✅ `单元测试` (test)
   - ✅ `CI 检查汇总` (ci-summary)

✅ **Require conversation resolution before merging**
   - 要求解决所有对话后才能合并

✅ **Do not allow bypassing the above settings**
   - 不允许绕过上述设置（包括管理员）

#### 可选配置

根据团队需求选择：

⬜ **Require deployments to succeed before merging**
   - 要求部署成功后才能合并（如果有部署流程）

⬜ **Require signed commits**
   - 要求签名提交（增强安全性）

⬜ **Require linear history**
   - 要求线性历史记录（禁止合并提交）

⬜ **Include administrators**
   - 管理员也必须遵守规则（推荐启用）

### 4. 保存规则

点击 **Create** 或 **Save changes** 保存配置

## 📊 配置效果

配置完成后，PR 合并时将强制检查：

| 检查项 | 说明 | 触发条件 |
|--------|------|----------|
| 🔍 **代码质量检查** | ESLint + Prettier 检查 | PR 创建/更新 |
| 📝 **TypeScript 类型检查** | 类型系统验证 | PR 创建/更新 |
| 🏗️ **构建检查** | 构建成功验证 | PR 创建/更新 |
| 🧪 **单元测试** | 测试用例通过 | PR 创建/更新 |
| 🤖 **AI 代码审查** | Claude AI 代码审查 | PR 创建/更新 |

## 🚫 常见阻塞场景

### 场景 1: 代码质量检查失败

**原因**: ESLint 或 Prettier 检查不通过

**解决**:
```bash
# 本地修复
pnpm run lint        # 自动修复 ESLint 问题
pnpm run format      # 格式化代码

# 提交修复
git add .
git commit -m "fix: 修复代码质量问题"
git push
```

### 场景 2: TypeScript 类型错误

**原因**: 类型检查失败

**解决**:
```bash
# 本地检查
pnpm exec tsc --noEmit

# 修复类型错误后提交
git add .
git commit -m "fix: 修复类型错误"
git push
```

### 场景 3: 构建失败

**原因**: 代码无法编译

**解决**:
```bash
# 本地构建测试
pnpm run build

# 修复构建错误后提交
git add .
git commit -m "fix: 修复构建错误"
git push
```

### 场景 4: 单元测试失败

**原因**: 测试用例不通过

**解决**:
```bash
# 本地运行测试
pnpm run test

# 修复测试后提交
git add .
git commit -m "fix: 修复单元测试"
git push
```

## 💡 最佳实践

### 1. 本地预检查

在提交 PR 前，本地运行所有检查：

```bash
# 完整的本地检查流程
pnpm run lint              # 代码质量检查
pnpm run format            # 代码格式化
pnpm exec tsc --noEmit     # 类型检查
pnpm run build             # 构建检查
pnpm run test              # 单元测试
```

### 2. 使用 Git Hooks

项目已配置 pre-commit hook，会在提交时自动运行检查：

```bash
# .claude/scripts/check-modified-files.sh
# 自动运行 lint 和 format
```

### 3. CI 缓存优化

CI 工作流已配置 pnpm 缓存，加快检查速度：

```yaml
- name: Cache pnpm dependencies
  uses: actions/cache@v4
  with:
    path: ${{ steps.pnpm-cache.outputs.pnpm_cache_dir }}
    key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
```

### 4. 并行检查

CI 工作流中多个检查并行运行，提高效率：

```yaml
jobs:
  lint-and-format:    # 并行运行
  type-check:         # 并行运行
  build:              # 并行运行
  test:               # 并行运行
  ci-summary:         # 等待以上全部完成
```

## 🔒 安全建议

1. **不要绕过检查**: 即使是管理员也应该通过正常流程
2. **审查 AI 建议**: AI 代码审查提供了额外的安全检查
3. **定期更新依赖**: 使用 `pnpm update` 更新依赖
4. **监控 CI 状态**: 关注 GitHub Actions 的运行结果

## 📞 故障排查

### CI 检查一直运行

**可能原因**:
- 依赖安装缓慢
- 测试用例死循环

**解决**:
1. 查看 GitHub Actions 日志
2. 本地复现问题
3. 优化测试用例或依赖

### 无法找到状态检查

**可能原因**:
- CI 工作流尚未运行
- 工作流配置错误

**解决**:
1. 确保 `.github/workflows/ci.yml` 已提交
2. 手动触发一次 CI 运行
3. 查看 Actions 标签页确认工作流状态

### 合并按钮被禁用

**正常现象**: 这说明保护规则生效了！

**解决**: 等待所有检查通过后，按钮会自动启用

## 📚 相关文档

- [GitHub 分支保护规则官方文档](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [CI 工作流配置](../../.github/workflows/ci.yml)
- [AI 代码审查配置](./ai-code-review-guide.md)
- [自动化版本管理](./auto-version-changelog.md)

## 🎉 完成

配置完成后，你的仓库将具有以下保护：

✅ 代码质量强制保障
✅ 类型安全验证
✅ 构建成功验证
✅ 测试覆盖验证
✅ AI 智能审查

**现在你可以放心合并代码了！** 🚀
