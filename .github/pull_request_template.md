> 发版 PR（`develop` → `master`）：可以只填一个临时标题直接创建，`Release PR Autofill` 会自动用 `CHANGELOG.md` 待发布内容替换标题和正文。

## 更新摘要

- 请用 1-3 条中文说明这次 PR 的核心变化

## 新功能

- 无

## 问题修复

- 无

## 优化调整

- 无

## 运维与流程

- 无

## 配置变更

- 无

## 验证记录

- [ ] `pnpm run ci:check`
- [ ] 关键链路已人工验证
- [ ] 未新增对开放自然语言直接 reject/覆盖/判缺的正则分支；如有探测需求，已先走 shadow diff
- [ ] 新增虚构 prompt 示例值均来自 `src/agent/guardrail/prompt/example-registry.ts`
- 其他说明：无
