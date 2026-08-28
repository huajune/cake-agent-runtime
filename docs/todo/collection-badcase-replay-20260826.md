# 收资 BadCase 近三周现场重放·执行清单（交 GPT 执行）

**所有者**：GPT 执行 + 用户验收
**状态**：待执行
**完成条件**：26 案逐案裁定 + 汇总报告交付；新缺口列册不擅自修
**发起背景**：2026-08-26。收资状态机（PR#1023 起）已全量入 develop 未发版；生产仍跑
legacy 链路。本任务把飞书 BadCase 近三周（08-05~08-26）收资相关案子的**原始现场**在
**新链路**上重放，回答"这些事故换新链路还会不会发生"。

---

## 0. 输入材料（已备好，勿重新拉取）

- **现场文件**：`logs/badcase-replay-20260826/{问题ID}.txt`，26 个。含标题/分类/状态/
  chatId/修复说明/聊天记录全文。聊天记录格式：`[MM/DD HH:MM 昵称] 消息`，托管账号名
  （ZhuDongSheng 等）= Agent，微信昵称 = 候选人。**内含真实 PII，此目录 git-ignored，
  严禁把任何内容原样复制进会提交的文件**。
- **契约快照**：同目录 `contract-snapshot-20260826.json`——0826 生产全量 576 在招岗的
  标签契约（`{jobs: {jobId:{name,brand}}, labels: [{jobId, labels:[...]}]}`），重放时的
  契约来源，不要实时打生产接口。
- **案件清单**：见 §1 表。

## 1. 案件清单与分诊（第一步先做）

核心 23 案（分类 6-报名与收资）+ 候补 3 案。**先读每案「修复说明」**：部分案子已带
`[v10.45.0复测][SCN-CUTOVER-20260820-***] 通过` 记号——0820 切换批已在新链路复测过，
这些案**只抽查不重跑**（抽 2-3 个验证记号可信），把预算花在无记号的案子上。

| 问题ID   | 日期  | 标题（脱敏）           | 状态   | 优先                                        |
| -------- | ----- | ---------------------- | ------ | ------------------------------------------- |
| 0091mnfr | 08-05 | 我都下车了怎么过去     | 已解决 | 低（先判是否收资域）                        |
| gu2kra6p | 08-06 | 电话是178\*\*\*\*9396  | 处理中 | **高**                                      |
| kz0c1pn7 | 08-06 | 是的是的               | 处理中 | **高**（裸终答形态）                        |
| v4s06s9h | 08-07 | 应该是周三十点才对     | 待分析 | 中（可能约面域）                            |
| 0zyiwkf3 | 08-11 | 没打                   | 待分析 | 中                                          |
| 801vu0bb | 08-12 | BOSS直聘引流开场       | 处理中 | 中                                          |
| 6bvnhbea | 08-13 | 对                     | 处理中 | **高**（裸终答）                            |
| 1zjtlr2l | 08-13 | 好                     | 待分析 | **高**（裸终答）                            |
| fd7hf81u | 08-13 | 本地办的               | 已解决 | 中（健康证族）                              |
| c5anuryw | 08-13 | 请问这个是兼职对吧     | 已解决 | 低（已有复测通过记号）                      |
| 62jkwopg | 08-14 | 行                     | 待分析 | **高**（裸终答）                            |
| lvftx4jx | 08-14 | 对确认                 | 待分析 | **高**（确认语义）                          |
| 7exhawrl | 08-17 | 没有健康证             | 待分析 | **高**（健康证三态+否定）                   |
| w8ach498 | 08-19 | 在的                   | 已解决 | 中                                          |
| y9zcw4ee | 08-19 | 今天还没到7点          | 已解决 | 低                                          |
| gorfe013 | 08-20 | 173\*\*\*\*3950        | 待分析 | **高**（手机号收资）                        |
| afrqeet1 | 08-24 | 没有问题               | 待分析 | **高**（0820 后新发）                       |
| e7ciuzhy | 08-24 | 1                      | 待分析 | **高**（0820 后新发）                       |
| 321y0own | 08-25 | 节假日排班三薪吗       | 待分析 | 中（0820 后新发）                           |
| cpbsp9wh | 08-25 | 大概什么时候面试       | 待分析 | 中（0820 后新发）                           |
| til165c8 | 08-25 | 没有提交成功是啥意思   | 待分析 | **高**（提交失败/errorList）                |
| ypzu02ai | 08-26 | 好的好的               | 待分析 | **高**（0826 新发）                         |
| 6t6qfm82 | 08-26 | 能不能干过80小时       | 待分析 | 中（0826 新发）                             |
| g6hmu2qw | 08-14 | 一直重复收集相同的信息 | 已解决 | **高**（答后复问=新链路根治主张的直接检验） |
| u9yi9ygt | 08-18 | 健康证需要自己办理     | 待分析 | 中（候补）                                  |
| q6a8yvdy | 08-20 | 姓名手机号一次报全     | 待分析 | **高**（模板整行回填形态）                  |

分诊裁定三桶：**A 重放**（收资域 + 无复测记号）/ **B 抽查**（已有复测通过记号）/
**C 不适用**（根因不在收资域：位置、约面时间、拉群、薪资答疑——写明归属域，不硬套）。

## 2. Lane A：纯逻辑重放（默认路径，B 桶外全部先过这里）

新链路收资核是纯函数，可以离线逐轮驱动，**不需要起服务、不需要 LLM**：

```
入口：runCollectionCore（src/tools/collection/collection-core.ts）
表单：createForm / verdictOf（@resolution/collection）
契约：快照 labels → ContractFieldSchema.parse 逐条 → mapContractFields(
      {jobId, fields}, parseIdentityAnchors('name:769,phone:770,age:687,gender:771'))
```

驱动模板（ts-node，从仓库根目录）：

```bash
npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json --transpile-only <你的重放脚本.ts>
```

参考实现：会话 scratchpad 里的 `simulate-templates.ts` 演示了快照→契约→渲染的完整管线；
`tests/tools/collection/collection-core.spec.ts` 演示了多轮驱动与统一 fieldValueProposals 构造。

逐案步骤：

1. **定位岗位**：从聊天记录里找被推荐/报名的岗位名 → 在快照 `jobs` 里模糊对名拿 jobId；
   案发岗已下线就选同品牌同形态岗替代，**报告里逐案声明契约来源与偏差**（案发时契约
   可能与 0826 快照不同——运营 0820-0826 做过大清理，这是本重放的已知边界，如实写）。
2. **切轮**：把聊天记录切成轮次，候选人消息作 `candidateTexts`，逐轮调 `runCollectionCore`，
   上一轮返回的 `form` 传入下一轮（多轮状态就是这么串的）。
3. **fieldValueProposals 构造**：主聊模型的作证在离线重放里没有，按两档跑：
   - 第一遍**不给 fieldValueProposals**——只测确定性通道（form_line 模板行回捞 + adapter_sweep），
     结论标「确定性通道行为」；
   - 第二遍给**合理 fieldValueProposals**（照 spec 的 `{labelTitle, value, quote}` 形态手工构造，
     labelTitle 逐字取自当岗契约，quote 必须是候选人原话里逐字存在的片段），结论标
     「含模型作证假设」。裸"对/好/行"类案子必须带 `agentQuestionQuote`（绑定 Agent
     上一问）才能作证——这正是要检验的机制。
4. **看什么**：每轮记录 `verdict / template.missingFields / askableFields / audits /
form.slots 状态`。对照案发现象逐条判：
   - 答后复问：filled 字段还出不出现在 missingFields/askableFields？
   - 判反/写错值：槽位值与候选人真实答案一致吗？公证有没有把错值挡下（proposal_rejected）？
   - 死锁/永卡：多轮后 verdict 是否收敛（ready/escalated），有没有永卡 collecting？
   - 熔断：同槽 2 问后是否 escalated？
   - 健康证三态、否定（"没有健康证"）、疑问句（"要健康证吗"不是答案）是否正确落格。

## 3. Lane B：真实链路复测（仅限 Lane A 判不动的案子）

适用：怀疑问题出在 prompt/模型作证层而非状态机层的案子。方法照
`src/skills/analyze-chat-badcases/`（SKILL.md + references/）的既有 SOP：本地起服务
（`.env.local` + 可用 Redis，Node 22.16.0）→ `/agent/debug-chat` 逐轮重放。红线：

- 身份一律换测试假身份 **兮兮 / 18271421690**，禁用现场真实姓名手机号；
- 只跑到 precheck/收资为止，**禁触发真实 entryUser 提交**；
- 起服务的坑见 CLAUDE.md（node 版本、Redis 必须可用）。

## 4. 报告要求（交付物）

逐案表：`问题ID | 案发现象（一句话） | 分桶 | 契约来源与偏差 | 新链路行为 | 裁定 | 证据`。
裁定四档封闭集：**已根治 / 仍会复现 / 行为改变待产品判 / 不适用收资域**。

汇总段：四档计数；**新缺口清单**（重放中发现的新链路自身问题——只列册+复现路径，
不擅自改码）；对「已有 0820 复测记号」案子的抽查结论（记号可信/不可信）。

硬性要求：

- **报告禁真实 PII**：姓名用姓氏+某、手机号打码（178\*\*\*\*9396）；
- 每个裁定必须给证据（form 状态 dump / audits / 渲染文本），不接受裸结论；
- 区分「确定性通道行为」与「含模型作证假设」两种结论，不混写；
- 全程只读生产数据；如需补查现场（chatId → `message_processing_records`），
  逐条 `SET LOCAL statement_timeout='8s'` 串行查，禁并发扫表；
- 报告落 `logs/badcase-replay-20260826/REPORT.md`（git-ignored，含案情引用无妨），
  另出一份**脱敏摘要**（可提交/可外发形态）放同目录 `SUMMARY-sanitized.md`。

## 5. 工程备忘

- Node：`nvm use 22.16.0`；jest 跑单测：`pnpm run test <spec路径> --watchman=false`；
- 收资域测试基线：`tests/resolution/collection` + `tests/tools/collection` 当前全绿
  （224 用例），重放 harness 不得改动 src/——发现缺口写进报告；
- 多人闸（suspected_multi_person）0826 刚接线，重放里若命中属预期新行为；
- 快照里标签已是运营清理后的形态（109→56 标签），案发时的旧标签（如 728「不要学生
  及暑假工」）已不存在——涉及旧标签的案子按当前契约重放并声明。
