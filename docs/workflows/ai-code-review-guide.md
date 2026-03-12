# AI Code Review 配置指南

**最后更新**：2026-03-12

本项目使用 **Claude Code CLI** 对 Pull Request 自动进行代码审查。

## 🚀 快速配置

### 1. 获取 Anthropic API Key

1. 访问 [Anthropic Console](https://console.anthropic.com/)
2. 注册或登录
3. 进入 **API Keys** 页面
4. 创建新 Key（以 `sk-ant-...` 开头）

### 2. 添加到 GitHub Secrets

1. 进入仓库 **Settings → Secrets and variables → Actions**
2. 点击 **New repository secret**
3. Name: `ANTHROPIC_API_KEY`
4. Value: 粘贴 API Key
5. 点击 **Add secret**

> 如果你本地已在使用 Claude Code，直接复用同一个 Key 即可。

### 3. 验证

1. 创建测试分支：`git checkout -b test/ai-review`
2. 修改任意 TypeScript 文件，提交并推送
3. 向 `develop` 分支发起 PR
4. 在 **Actions** 标签页查看工作流执行
5. 审查结果会以评论形式出现在 PR 页面

---

## 📋 审查内容

✅ **Critical Issues** — Bug、安全漏洞（硬编码密钥、SQL 注入、XSS）、性能问题

✅ **Code Quality** — TypeScript 严格类型、NestJS 模式合规、错误处理

✅ **Architecture Concerns** — DDD 层级违规、服务职责越界、模块组织

✅ **Suggestions** — 改进建议和优化方向

---

## 🎯 触发条件

工作流在以下情况自动运行：

- 向 `develop` 分支发起新 PR
- 已有 PR 推送了新提交
- PR 被重新打开

**仅审查**：`.ts`、`.js`、`.tsx`、`.jsx`、`.mts`、`.cts`、`.mjs`、`.cjs`、`.d.ts` 文件

> ⚠️ 只有目标分支为 `develop` 的 PR 会触发 AI 审查。

---

## 📊 审查格式

```markdown
## 🤖 AI Code Review

**Changes Summary:**
- 📝 Files changed: X
- ➕ Lines added: Y
- ➖ Lines removed: Z

---

### Critical Issues
[安全漏洞、Bug、性能问题]

### Code Quality
[TypeScript、NestJS 最佳实践]

### Architecture Concerns
[DDD 层级、职责边界]

### Suggestions
[优化建议]

---
Powered by Claude Code 🚀
```

PR 重复推送时，机器人会**更新同一条评论**，不会重复发帖。

---

## 🔧 自定义配置

### 调整审查范围

修改 `.github/workflows/ai-code-review.yml`：

```yaml
# 修改文件类型匹配
grep -E '\.(ts|js|tsx|jsx|py|go)$'

# 调整 diff 大小限制（默认 50KB）
DIFF_OUTPUT=$(git diff ... | head -c 100000)
```

### 自定义审查规则

AI 会自动读取 `.cursorrules` 文件中的项目规范。更新该文件即可调整审查标准，无需修改 workflow。

### 更换 Claude 模型

修改 `.github/scripts/ai-code-review.sh` 中的提示词或使用 `ANTHROPIC_MODEL` 环境变量（如 Claude Code CLI 支持）。默认使用 Claude Code CLI 的当前最新模型。

---

## 💡 最佳实践

**提 PR 前：**

- 先运行 `pnpm run lint` 和 `pnpm run format`，修复明显问题
- 使用规范的 commit message

**响应 AI 审查时：**

- 优先处理 Critical Issues
- Suggestions 可选择性采纳
- 在 PR 评论中说明你的处理方式

**大型 PR：**

- 拆分为更小的 PR（AI 审查在 500 行以内最有效）
- Diff 超过 50KB 时会被自动截断

---

## 🐛 排查问题

### Workflow 失败

1. **检查 API Key**：确认 secret 名称为 `ANTHROPIC_API_KEY`，Key 有余额
2. **检查权限**：需要 `contents: read` 和 `pull-requests: write`
3. **查看日志**：Actions 标签页 → 选择失败的 workflow → 逐步查看日志

### 没有审查评论

- 确认 PR 中有 TypeScript/JavaScript 文件变更
- 确认 API Key 有效且有余额
- 查看 Actions 日志中是否有错误

---

## 📈 成本参考

- **计费方式**：按 Claude API token 计费，与本地 Claude Code 使用同一个 Key
- **典型用量**：每次审查约 5,000–10,000 tokens
- **参考费用**：约 $0.03–0.20 / 次（约 ¥0.2–1.4）

---

## 🔒 安全

- API Key 以加密形式存储在 GitHub Secrets
- 不要将 Key 提交到代码仓库
- 定期轮换 Key，监控异常使用

---

## 📚 相关资源

- [Anthropic API 文档](https://docs.anthropic.com/)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [项目编码规范](.cursorrules)
