# 发版底账

`docs/releases/` 保存需要长期审计的正式发布记录。它是可选制品，不是 CHANGELOG 的替代品：
CHANGELOG 说明“发布了什么”，发版底账回答“为什么可以发布、验证了什么、如何回滚、上线结果如何”。
未创建底账、底账未定稿或没有回填发布结果都不会阻塞 Release PR、tag 或部署。

## 目录与命名

- 准备期：`docs/releases/YYYY/pending-YYYY-MM-DD-pr-NNN.md`
- 版本号由发布自动化确定后：重命名为 `docs/releases/YYYY/vX.Y.Z.md`
- 模板：[`_template.md`](./_template.md)

同一生产发布只保留一份底账。多个实现 PR 进入同一 release 时，应合并维护同一份文件，
不得为每个功能 PR 各建一份“正式发布”记录。

## 可选生命周期

1. **草稿生成（推荐起点）**：发版前运行 `pnpm run release:ledger`——从
   `.release/pending-release.json` 渲染 `docs/releases/YYYY/v{next}.md` 草稿，
   P0 表按各实现 PR 的验证记录预填。生成稿带 `<!-- auto-generated-from-pending-release -->`
   标记；人工修订定稿时删除该标记（否则下次生成会清理/覆盖它）。
2. **人工复核**：检查 P0 表是否需要补真实回归 case、高风险区域/migration/回滚条件是否属实；
   复杂发布仍可从 `_template.md` 手写 pending 底账走完整流程。
3. **证据复核**：如维护底账，确保其中勾选项与实际执行一致；豁免或未执行项不得写成通过。
4. **版本固化**：版本号与文件名由 `nextVersion` 对齐（生成器自动处理；手写 pending 文件则重命名为 `vX.Y.Z.md`）。
5. **发布闭环**：补齐 tag、release、部署时间、生产验证、监控和遗留事项。

`pnpm release:ledger:check` 仅用于主动校验已选择维护的底账，正式 `develop → master`
Release PR 不再自动运行该命令，也不要求仓库存在当前版本底账。

## 维护原则

- case 必须来自实际 diff 和风险，不复制固定清单凑数。
- 正式测试资产仍通过 `analyze-chat-badcases` 策展后进入飞书测试集/验证集。
- 结果必须记录实际命令、批次、PR、Actions 或监控链接；不得预先勾选。
- 数据库、配置、权限、外部服务、部署顺序和回滚方案即使为 N/A 也要明确写出。
- 不写入 token、密钥、候选人隐私或未脱敏生产对话。
- 发布后底账作为历史记录保留；后续修订需注明日期、原因和修订人。
