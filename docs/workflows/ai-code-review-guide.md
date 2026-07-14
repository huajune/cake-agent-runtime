# AI Code Review 配置指南

**最后更新**：2026-07-14

本项目使用 **Claude Code Action** 对 Pull Request 自动进行代码审查。Claude 只负责
生成符合 JSON Schema 的结构化结论，GitHub Actions 再使用 Claude App token 确定性
提交 `APPROVED` 或 `CHANGES_REQUESTED`，不依赖模型自行执行最后一条 `gh` 命令。

## 🚀 快速配置

### 1. 获取 Claude Code OAuth Token

按照 Claude Code Action 官方说明生成可用于 GitHub Actions 的 OAuth token。

### 2. 添加到 GitHub Secrets

1. 进入仓库 **Settings → Secrets and variables → Actions**
2. 点击 **New repository secret**
3. Name: `CLAUDE_CODE_OAUTH_TOKEN`
4. Value: 粘贴 OAuth token
5. 点击 **Add secret**

> workflow 通过 `claude_code_oauth_token` 读取该 secret。

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

每次新 HEAD 都必须产生一个新的明确裁决。行内建议可以由 Claude 直接发布，最终
`APPROVED` / `CHANGES_REQUESTED` 由 workflow 根据结构化输出统一提交。

---

## 🔧 自定义配置

### 自定义审查规则

AI 会读取 `.github/review-rules.md`。更新该文件即可调整审查标准，无需修改 workflow。

### 更换 Claude 模型

在 `.github/workflows/ai-code-review.yml` 的 `claude_args` 中配置 Claude Code Action
支持的模型参数。未指定时使用 Action 当前默认模型。

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

1. **检查 OAuth token**：确认 secret 名称为 `CLAUDE_CODE_OAUTH_TOKEN`
2. **检查权限**：需要 `contents: read` 和 `pull-requests: write`
3. **查看日志**：Actions 标签页 → 选择失败的 workflow → 逐步查看日志

workflow 采用 fail-closed：Claude 达到 `max-turns`、Action 异常退出或结构化输出不合法
时，会幂等提交一条 `github-actions[bot]` 的阻塞 review，并将检查标红。后续成功产生
有效 Claude 裁决时，workflow 会自动撤销仅由该固定兜底文案创建的历史阻塞 review。

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
