/**
 * 写入适配器的统一契约。
 *
 * 适配器**只换输出端**：字段语义的判定逻辑一律留在既有解析器
 * （`@resolution/candidate/*`、健康证资格状态机…），适配器负责把它们的产物翻译成
 * 「槽位值提案」。总纲 §5「存活资产」：全部解析器/公证内核/身份闸门/健康证 policy
 * 挪位为写入守卫与迁移判据，代码复用，不重写。
 *
 * 适配器**不做公证**——出处/契约形态/已知冲突/归属/筛选五门全在字段值提案写入口，
 * 适配器给出的一切都是"提案"，被拒是正常出口。
 */

import type { CandidateFactProducer } from '@resolution/candidate/types';
import type { ContractFieldDef } from '../form.types';

/** 适配器产出的槽位值提案（未公证）。 */
export interface SlotProposal {
  labelId: number;
  value: string;
  optionCodes?: string[];
  /** 候选人原话逐字片段。取自解析器返回的 excerpt / 命中子句，不得改写。 */
  sourceText: string;
  /**
   * 署名如实（红线）：确定性适配器一律 `candidate_quote`——词表口径「候选人原话来的：
   * 自陈 quote 复算」，正是适配器在做的事。禁 `system` 冒名，禁 `rule`
   * （P11 已把 rule 移出可持久化产者白名单）。
   */
  producer: CandidateFactProducer;
}

/** 适配器入参：当岗契约字段 + 本轮候选人可作证语料。 */
export interface AdapterInput {
  field: ContractFieldDef;
  /** 本轮候选人原话（已剥引用块与时间后缀）。 */
  candidateText: string;
  /** 跨轮已知的同字段历史值，健康证等需要二次确认的字段用。 */
  historicalValues?: readonly unknown[];
  /**
   * candidateText 是否已绑定到本槽位——表单行回填（「社保缴纳情况：无」拆行后的值）、
   * fieldValueProposals 定位后的规范值、档案预填值为 true；轮末安全网的自由语料扫描为 false。
   * 绑定后适配器才允许解释裸短答（「无」「没有」）——脱离语境的裸否定能回答任何一问。
   */
  answerBound?: boolean;
}

/** 提案不出来就返回 null——绝不猜（追问的代价远小于报错人）。 */
export type SlotAdapter = (input: AdapterInput) => SlotProposal | null;
