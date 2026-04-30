/**
 * 发薪/工资类问题"甩锅给到店再问"的输出兜底检测。
 *
 * 业务背景：候选人问"工资怎么发 / 发哪张卡 / 几号到账"等发薪/合规问题时，
 * Agent 必须基于当前岗位/品牌薪资规则直接回答，禁止把问题甩给候选人到店或
 * 面试时自己问店长（合规风险转嫁）。Prompt 已写过禁止短语，但模型偶尔违反，
 * 这里在投递层做最后一道兜底——命中即静默丢弃整条回复，与 leak-guard 同策略。
 *
 * 仅在候选人**问的是发薪/工资类问题**且 Agent 用了"甩锅措辞"时命中；纯岗位
 * 介绍中"到店面试"是合法表达，不算违规。
 */

const PAYROLL_TOPIC_HINTS =
  /(工资|薪资|发薪|薪水|到账|发卡|银行卡|微信发|发别人卡|几号发|工资几号|怎么发钱)/;

const DEFER_TO_STORE_PHRASES = [
  /到店(?:再)?问/,
  /到店(?:再)?(?:确认|核实)/,
  /面试(?:时|的时候|当天)(?:再|跟|问|和)\S*(?:店长|经理|店里)/,
  /(?:你|您)?(?:可以|可以)?(?:跟|和|问)\S*店长(?:确认|核实|沟通|聊|问)/,
  /(?:跟|和|问)\S{0,4}店里\S{0,4}(?:确认|核实|聊)/,
  /店长(?:那边|那)?(?:再)?确认/,
];

/**
 * 仅当回复中**同时**出现 (a) 发薪/工资话题词 + (b) 甩锅措辞 时才命中。
 * 这样既覆盖目标违规，又不误伤"到店面试"等合法表达。
 */
export function detectPayrollDeferToStore(content: string): RegExp | null {
  if (!content) return null;
  if (!PAYROLL_TOPIC_HINTS.test(content)) return null;
  for (const pattern of DEFER_TO_STORE_PHRASES) {
    if (pattern.test(content)) return pattern;
  }
  return null;
}
