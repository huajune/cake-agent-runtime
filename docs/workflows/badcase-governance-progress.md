# BadCase 治理进展自动同步

## 目标

把 BadCase 从“备注里堆 ID、靠人工回忆修复时间”升级为可自动对账的治理台账，并在每次状态或证据更新后，把本次进展累计写入飞书 Wiki `BadCase 治理进展同步`。

不再生成或发送 BadCase 周报。

## 状态关闭规则

BadCase 仍只使用四个运营状态：`待分析 / 处理中 / 待验证 / 已解决`。

`已解决` 必须同时满足：

1. 最近一次场景测试（scenario）通过；
2. 最近一次回归验证（conversation）通过。

只有一侧通过时为 `待验证`；任一侧失败为 `待验证`；任一侧待评审为 `处理中`。系统从 `测试证据JSON` 合并历史证据，不用单个当前批次直接覆盖结论。

## 表字段

| 字段 | 用途 |
| --- | --- |
| 首次发现时间 | 记录问题进入治理池的时间 |
| 问题原因 | Web 反馈入口的运营可筛选原因；与历史混合口径的「分类」隔离 |
| 状态更新时间 | 记录状态事件 |
| 解决时间 | 记录双门禁首次通过时间 |
| 处理结论 | 待归因、修复验证通过、已上线待观察等 |
| 上线时间 / 观察截止时间 | 管理待观察问题 |
| 待确认方 | 无、运营、产品、技术、数据 |
| 当前责任人 | 日常跟进 |
| 期望处理方式 | 反馈提交人描述正确行为 |
| 测试证据JSON | 版本化机器证据台账 |
| 证据结论 / 证据更新时间 | 快速查看总判定 |
| 测试CaseID / 测试执行ID / 测试批次ID | 最近 scenario 证据 |
| 验证CaseID / 验证执行ID / 验证批次ID | 最近 conversation 证据 |
| 评审来源 | manual、codex、claude、system、api |

## 历史证据回填

脚本默认只盘点，不写数据：

```bash
node scripts/backfill-badcase-evidence.js --base-url=http://127.0.0.1:8586
```

确认后执行：

```bash
node scripts/backfill-badcase-evidence.js --base-url=http://127.0.0.1:8586 --apply
```

历史回填明确关闭治理文档同步，避免把存量清账批次误写成新进展。

## 治理文档写入规则

目标 Wiki 由 `FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN` 配置。系统会：

1. 解析 Wiki 节点得到 Docx token；
2. 读取文档块并定位 `四、近两周状态清账说明`；
3. 在该章节之前追加本轮更新，使内容留在 `三、主要治理批次`；
4. 按现有格式写三级日期标题、更新说明和项目符号；
5. 写入稳定 `治理事件ID`，重试时先查重。

同一批状态回写只生成一个治理小节。项目符号包含：

- 问题类型；
- BadCase ID；
- 问题标题；
- 最新状态；
- 测试批次 ID；
- 测试集与验证集证据结论。

只读检查：

```bash
curl -X POST http://127.0.0.1:8586/feishu/sync/badcase-governance/document-check \
  -H "Authorization: Bearer $API_GUARD_TOKEN"
```

生产配置：

```dotenv
FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN=WUEzwZlYOienOgkw7z1cpeOVnBB
BADCASE_GOVERNANCE_DOC_SYNC_ENABLED=false
```

先保持 `false` 验证 dry-run 日志。确认格式和权限后改为 `true`。

## Web 反馈入口

BadCase 提交项包括：

- 主聊 15 类、复聊 8 类运营问题原因；
- P0 / P1 / P2 影响级别；
- 期望正确处理方式；
- 备注和截图；
- 会话、消息、trace 等来源证据。

新建记录默认 `状态=待分析`、`处理结论=待归因`、`待确认方=无`，并写入 `首次发现时间`。
