# 执行 TODO：品牌提及集合与工具示例治理

日期：2026-09-10。依据：首轮虚构会话记忆事故及本任务中确认的实施范围。

## 已确认边界

- 不新增 quote/sourceRef，不增加 LLM 判断，不扩展地址或出站拦截。
- TurnLedger 汇总业务上下文中提及过的标准品牌；正向、负向、履历、推荐均算提及，不改变品牌意向状态和记忆写入语义。
- 来源包括完整消息窗口与引用、昵称、短长期品牌事实、历史/当前岗位、视觉事实及本轮真实工具结果；不包含教学、工具说明、推理、当前请求参数或失败回显。
- 查岗对明确归一化成功的模型品牌参数做集合校验；空集合有效，来源加载失败或无法确认归一化时不新增出处拦截。优先避免误拦。
- 品类展开、别名、可映射品牌 ID、合法历史及图片来源均须兼容。
- 保留现有候选池最新快照语义；品牌集合轮内累计，不随后一次查询覆盖而丢失。
- 保留真实业务规则、枚举、字典和必要地理映射示例；删除无教学必要的具体实体、ID、日期、坐标和仿会话记忆格式。
- 当前工作区存在其他任务改动，不回退、提交或整理无关修改。

## 执行清单

- [x] Ledger 增加 mentionedBrands，接通开轮汇总及图片/查岗结果增量。
- [x] 查岗归一化后、外部查询与候选人文案生成前接入品牌集合校验。
- [x] 完成正常来源与失败放行测试，覆盖首次真实品牌、别名、负向提及、品类展开、历史、视觉和连续查岗。
- [x] 手册新增唯一的规则/示例与当前会话事实边界说明。
- [x] 清理 geocode、invite_to_group、job_list description 与 schema 示例。
- [x] 清理图片工具固定品牌 ID 和改约工具固定日期。
- [x] 同批更新 prompt-rule-ledger，登记品牌错误恢复说明及示例改动。
- [x] 执行快照保存工具 description 和完整输入 JSON schema（含字段说明）。
- [x] 后台最终提示词面板展示执行时工具定义，兼容旧记录缺快照。
- [x] 完成相关单测、类型检查、lint/格式及必要前端验证；记录结果。

## 实现落点

- `types/turn.types.ts`、`generator/preparation/turn-context-resolver.ts`、`turn-ledger.ts`：集合开轮构建并持续累计；`null` 表示来源不可用，空集合表示已加载但没有提及。
- `resolution/brand/brand-matcher.ts`：复用品牌目录、别名归一化和品类配置做机械词形匹配。短品牌、负向提及、歧义候选照收；品类独立展开，避免被同段具体品牌遮蔽。
- `tools/job-list/brand-query.util.ts`、`duliday-job-list.tool.ts`：只核验明确归一化的 `model_input` 品牌，失败返回 `job_list.brand_no_provenance`，在外部查岗前停止。失败参数及错误回显不写入集合，因此同一品牌重试仍须通过集合校验。
- `recall_history` 的真实摘要、`read_resume_attachment` 的成功正文补入集合；没有 messageId 的简历也能登记提及。图片和岗位结果通过已有 ledger 写入口追加。
- 手册 G0 集中声明示例与事实边界；必要地名映射只留在 geocode；全部提示词改动登记到 `docs/prompt-rule-ledger.md`。
- `llm/tool-definition-snapshot.ts` 保存调用时工具说明和 JSON schema；后台最终提示词据历史快照展示。缺失旧快照明确提示，不用当前定义补造历史。

## 验证结果

- 生成器、工具、品牌解析、快照、后台渲染及观测链回归：**111 个套件通过，1626 项测试通过，5 项跳过，3 个快照通过**。使用 `--runInBand --watchman=false`；完整输出位于本机 `/tmp/cake-brand-mentions-final-tests.log`。
- 额外图片描述相关回归已通过；手册正文修改后核对并更新 prompt compatibility 的字节基线。
- `pnpm run typecheck`：通过。
- 本次修改的后端源文件 ESLint、Prettier：通过；后台修改文件的 lint、格式及前端 TypeScript/Vite 构建：通过。
- `git diff --check`：通过。
- 全仓 `pnpm run lint:check` 最后一次运行未通过：另一项并行改动的 `src/agent/runner/agent-runner.service.ts` 有 9 处 Prettier 错误；本任务未改动该文件，未为消除检查报错覆盖其他任务的工作。

本次完成本地实现与验证，未部署或执行生产模型回放。集合只能证明业务上下文曾提及，不能证明候选人意向；历史助手话术或已有污染记忆中的品牌仍可能放行，符合本次优先避免误拦的边界。

## 2026-09-10 文件精简

- [x] 开轮品牌汇总并回现有 `turn-context-resolver.ts`，作为内部函数；删除独立的 `mentioned-brands.ts`。
- [x] 共用品牌提及匹配并回现有 `brand-matcher.ts`；删除独立的 `brand-mentions.ts`，修正 Ledger 导入。
- [x] 原品牌提及测试分别并入已有 resolver 与 Ledger 测试；删除独立测试文件，保留全部行为用例。
- [x] 完成迁移后的回归、类型与格式检查：19 个套件、403 项测试全部通过；全仓 TypeScript 检查、本次源文件 ESLint、格式及 `git diff --check` 通过。旧模块导入和文档实现路径已清除。
