/**
 * 不合格原因的**披露分级**（总纲 §2.8 构造性质④补充，2026-08-17 裁定）。
 *
 * 铁律：**判定入账永远如实**（账本落 labelId + 命中项 + 证据），委婉只在渲染层。
 * 本文件只回答一个问题：这条不合格原因能不能对候选人明说。
 *
 * 三档：
 * - `open` 可明说族：年龄/性别/学历/健康证/身高体重等岗位硬性条件。PR #421 运营裁决
 *   口径——性别与年龄要求属岗位公开信息（岗位卡本来就写「18-40岁，仅限男」），
 *   直说要求 + 转岗是合规的；
 * - `restricted` 禁明说族：户籍/籍贯/民族/专业/婚育等出站守卫红线，**以及未知新标签**。
 *   绝不披露真实原因，渲染为换岗/拉群承接（noMatchScript 家族），且禁止在敏感答案
 *   紧邻回合触发拒绝（因果隔离）；
 * - 默认档 = `restricted`。新标签天天有，默认可说 = 每个新配置都是一次外露赌博。
 *
 * **禁说词表禁止另立副本**（蓝图 §11）：敏感判据唯一引用
 * `./sensitive-screening` 的 `containsSensitiveScreeningText`——出站守卫
 * discrimination-leaks 与岗位渲染读的是同一份常量。本文件一个敏感词都不自己写。
 */

import { containsSensitiveScreeningText } from './sensitive-screening';
import type { ContractFieldDef } from './form.types';

export type DisclosureLevel = 'open' | 'restricted';

/**
 * 可明说属性族的**标题**判据（词面判定，不认 labelId——D4）。
 *
 * 收录门槛：该属性是否已经印在岗位卡上给候选人看。印了的（年龄/性别/学历/健康证/
 * 身高体重/在岗时长）说出来不增加任何信息暴露；没印的一律不进这张表。
 * 加词前先回答「候选人自己在岗位卡上看得到吗」，答不上来就别加。
 */
/**
 * 敏感属性的**标题面**判据——与 `containsSensitiveScreeningText` 的散文面判据互补，
 * 不是它的副本。
 *
 * 为什么需要第二个判据面：共用词表是给**岗位自由文本**调的，那里裸「专业」满地都是
 * 形容词用法（"专业培训""我们很专业"），所以它刻意只认「专业（…」「相关/类/所学专业」
 * 「专业要求/限制/背景」这些组合形态，**裸标题「专业」认不出来**。而契约字段**标题**
 * 是另一种文本：一个叫「专业」的字段不可能是形容词，它就是学科筛选。
 *
 * 0826 复测：专业族已合并为「专业(213)」且契约返 RESTRICTED（籍贯/婚育同），
 * 缺口已闭合；本红线保留为与契约标记**并行的第二道闸**——防运营新建敏感标签漏标。
 * 收词纪律与共用词表一致：只收**属性名本身**，不收组合形态（组合形态归共用词表）。
 */
const SENSITIVE_TITLE_FAMILIES =
  /^(?:专业|所学专业|专业背景|婚育|婚姻|婚姻状况|生育|生育情况|民族|籍贯|户籍|户口|户籍省份|政治面貌|宗教信仰)/u;

const OPEN_TITLE_FAMILIES =
  /年龄|性别|学历|文化程度|健康证|身高|体重|在岗多久|预计在岗|工作时长|排班|上班时间/u;

/**
 * 判定某个契约字段的不合格原因披露级别。
 *
 * 判据顺序刻意如此：契约 RESTRICTED → 红线词表 → 可明说白名单 → 默认禁明说。
 * **红线排在白名单之前**：白名单是人维护的，红线不能被人维护的表压过；
 * **红线也排在"契约说 PLAIN"之前**：PLAIN 只表示"后端没标"，不表示"确认可说"。
 */
export function disclosureLevelOf(field: ContractFieldDef): DisclosureLevel {
  // ① 契约标记（0820 落地，实测籍贯[3]=RESTRICTED）：后端明说禁明说就是禁明说。
  if (field.disclosure === 'RESTRICTED') return 'restricted';
  // ② 红线词表：**压过契约的 PLAIN**。契约的 PLAIN 不是"确认可说"，只是"没标"——
  //    新建敏感标签漏标 RESTRICTED 时（0820-0826 专业族即如此），只信契约就会把
  //    敏感拒因当面告诉候选人。红线是唯一不降级的那条（蓝图 v3-lean 头注）。
  if (SENSITIVE_TITLE_FAMILIES.test(field.labelTitle)) return 'restricted';
  if (containsSensitiveScreeningText(field.labelTitle)) return 'restricted';
  if (containsSensitiveScreeningText(field.labelInstructions ?? '')) return 'restricted';
  // ③ 可明说白名单：岗位卡本来就印着的硬性条件。
  if (OPEN_TITLE_FAMILIES.test(field.labelTitle)) return 'open';
  // ④ 默认禁明说。
  return 'restricted';
}

/** 该字段的拒绝理由是否可以对候选人明说。 */
export function canDiscloseRejection(field: ContractFieldDef): boolean {
  return disclosureLevelOf(field) === 'open';
}

/**
 * 该字段是否**确凿敏感**——有明确的敏感信号，而不只是"没被标成可明说"。
 *
 * ⚠️ 与 `disclosureLevelOf(field)==='restricted'` 不是一回事，别混用：
 * 那个判的是"这个字段的**拒绝理由**能不能说"，未知字段一律保守归 restricted
 * （包括姓名、手机号这种根本不会成为拒绝理由的字段）。因果隔离要问的是另一个问题
 * ——"候选人刚才答的是不是一个敏感属性"。拿 restricted 当敏感判据会让候选人
 * **每报一次姓名就顺延一轮拒绝**，把因果隔离变成无差别拖延。
 */
export function isSensitiveAttribute(field: ContractFieldDef): boolean {
  return (
    field.disclosure === 'RESTRICTED' ||
    SENSITIVE_TITLE_FAMILIES.test(field.labelTitle) ||
    containsSensitiveScreeningText(field.labelTitle) ||
    containsSensitiveScreeningText(field.labelInstructions ?? '')
  );
}

/**
 * 因果隔离（2026-08-17 裁定）：禁止在候选人刚回答敏感字段的那一轮触发拒绝——
 * 哪怕话术再委婉，紧邻时序本身就把因果说出去了（"我刚说完籍贯它就说没岗位了"）。
 *
 * 调用方在渲染拒绝话术前问一句：本轮是否有**确凿敏感**字段刚落值？是则本轮不拒，
 * 拒绝顺延到下一轮（表单状态已是 disqualified，不会丢）。
 */
export function shouldDeferRejection(fieldsAnsweredThisTurn: readonly ContractFieldDef[]): boolean {
  return fieldsAnsweredThisTurn.some(isSensitiveAttribute);
}
