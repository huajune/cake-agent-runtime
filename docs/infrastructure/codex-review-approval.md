# Codex 官方评审与 GitHub 正式批准

Codex 官方 Connector 负责审查代码，`Codex Review Approval` 工作流负责把可核验的无问题结果转换成 GitHub `APPROVE`。只使用 GitHub 自动提供的 `GITHUB_TOKEN`，不需要 OpenAI API key、Codex 登录凭证或新的第三方账号。

## 通过条件

- 同仓库、非草稿、未关闭、目标 `develop` 的 PR。
- 官方 summary 身份同时匹配固定数字 ID、login 和 Bot 类型；点赞接口实际将机器人序列化为 User，因此点赞身份以相同的固定数字 ID 和 login 核验。
- 唯一官方 summary 中必须有 Code Review，所有列出的评审均 Completed，提交 SHA 与实时 PR HEAD 一致。
- PR 本身有官方机器人在本轮评审完成后创建的 👍；没有代表仍在评审的 👀。只看到 Completed 不足以批准。
- 当前提交没有 Codex 建议 review 或原始行评论；没有其他评审者仍然有效的 Request changes。
- 不修改 `.github/`、批准脚本或对应测试。批准机制本身需要独立评审，不能自动自审放行。

写入前重新读取全部证据，绑定完整 HEAD SHA；写入后再次校验，发生变化立即撤回本流程的批准。相同证据重复触发不重复提交。新提交、转草稿或 Codex 重新评审会撤回失效的桥接批准；不会撤回人工批准或实质性问题评审。保留现有必需 CI 和最后一次推送审批规则。

摘要格式变化、证据不足、API 错误均不自动批准。当前提交曾产生 Codex 建议时，即使手动解决讨论，也应提交修复后重新评审；不依赖“已解决”按钮判定代码已修好。旧提交的行评论可能被 GitHub 映射到新提交，判断其来源使用 `original_commit_id`。

## GitHub 设置和启用

1. 在 Codex 网页为仓库开启自动 Code Review，选择需要的触发方式。
2. GitHub → Settings → Actions → General → Workflow permissions，启用 **Allow GitHub Actions to create and approve pull requests**。本仓库已启用。
3. 工作流及脚本首次合入默认分支 `develop` 后生效。首次引入或修改批准机制的 PR 需要独立批准，不能依靠尚未合入的流程批准自身。
4. Codex 官方 summary 创建/更新时自动校验；新提交先撤回旧桥接批准。若 summary 比 👍 提前到达，最多等待约一分钟。若 👍 延迟更久，在 Actions 手动运行 **Codex Review Approval**，填 PR 编号；也可用下述命令。

```bash
gh workflow run codex-review-approval.yml --ref develop -f pr_number=1369
```

工作流始终检出默认分支的脚本，不检出 PR 代码，不安装 PR 依赖，不执行评论内容。仅授予 `contents: read`、`issues: read`、`pull-requests: write`。手动运行也必须选择默认分支。

只读诊断（使用本机已有 GitHub CLI 登录，不复制或输出凭证）：

```bash
GITHUB_REPOSITORY=huajune/cake-agent-runtime PR_NUMBER=1369 \
  GH_TOKEN="$(gh auth token)" node scripts/codex-review-approval.js
```

Actions 日志和 step summary 会说明本轮是否提交批准，以及未批准的具体原因。此流程不会合并 PR、修改保护规则或触发生产部署。

## Claude 保留与恢复

旧 `.github/workflows/ai-code-review.yml` 和已有 Claude secret 保留；旧工作流在 GitHub Actions 处禁用。只有在最新 Codex 证据确认无问题并正式批准后，才清理旧 Claude 自动化失败留下的固定文案 Request changes；不删除评审历史，不清理实质性问题。

Claude 账号恢复后：先停用 `Codex Review Approval`，按需要关闭 Codex 网页自动评审，再启用旧 `AI Code Review`，手动选择一个 PR 验证；只有 OAuth 已失效时才更新原 secret。不同时启用两套自动裁决流程。

```bash
gh workflow disable codex-review-approval.yml
gh workflow enable ai-code-review.yml
gh workflow run ai-code-review.yml --ref develop -f pr_number=1369
```

测试：`pnpm exec jest tests/scripts/codex-review-approval.spec.ts --watchman=false --runInBand`。
