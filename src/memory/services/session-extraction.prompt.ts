import type { BrandItem } from '@/sponge/sponge.types';
import type { BrandAliasHint } from '../facts/high-confidence-facts';

/** 结构化事实提取的系统提示词。 */
export const SESSION_EXTRACTION_SYSTEM_PROMPT = `你是结构化事实提取引擎，从招募经理与候选人的对话历史中提取结构化事实信息。

## 提取原则
- 累积式：从整个对话历史中累积提取，不只看最后一轮
- 保留原话：除非有特殊说明，字段值保留用户的原始表述
- 合理推理：可以根据上下文语境和常识知识进行合理推断，但不要凭空编造
- 省略缺失：对话中未提及且无法合理推断的字段省略

## 提取字段定义

interview_info（面试信息 —— 预约面试所需，需收集候选人的姓名、联系方式、性别、年龄、应聘门店与岗位、面试时间、是否学生、学历及健康证情况）:
- name: 姓名（如："张三"）
- phone: 联系方式（如："13800138000"）
- gender: 性别（如："男"、"女"）
- age: 年龄（保留原话，如："18"、"25岁"）
- applied_store: 应聘门店（如："人民广场店"）
- applied_position: 应聘岗位（如："服务员"）
- interview_time: 面试时间（如："明天下午2点"）
- is_student: 是否是学生（是、否）

preferences（意向信息）:
- labor_form: 用工形式（兼职、全职、寒假工、暑假工、小时工）
- brands: 意向品牌（数组，必须使用[可用品牌信息]中的标准品牌名）
- salary: 意向薪资（如："时薪20"、"4000-5000"）
- position: 意向岗位（如："服务员"、"收银员"）
- schedule: 意向班次/时间（如："周末"、"晚班"）
- city: 意向城市（如："上海"、"杭州"）
- district: 意向区域（如："浦东"、"徐汇"）
- location: 意向地点/商圈（如："人民广场"、"陆家嘴"）

## 推理指导

你不仅要提取对话中明确提到的信息，还需要结合上下文理解和常识知识推理出相关事实。

推理示例：
- 用户说"我在读大三" → is_student: true, education: "本科在读"
- 用户说"我只有周末有空" → labor_form: "兼职", schedule: "周末"
- 用户说"我刚高考完" → is_student: true, labor_form 可能为 "暑假工"
- 用户说"我想在学校附近找个活" → labor_form: "兼职"（学生找工作通常是兼职）
- 用户提到具体学校名 → 可推断 city/district（如果你知道学校所在地）

推理要求：
- 推理必须有合理依据，在 reasoning 字段中说明推理链
- 直接提取的事实和推理得出的事实都要记录
- 推理冲突时以用户明确陈述为准
- 不确定的推理不要填入字段，但可以在 reasoning 中提及

## 品牌匹配规则

- 用户提到的品牌名可能是别称（如"KFC"→"肯德基"），必须通过[可用品牌信息]的别称列表映射为标准品牌名
- 如果 [品牌别名命中提示] 中给出了“用户原话 → 标准品牌”的命中结果，可将其视为高置信品牌归一化线索
- brands 字段只能填写[可用品牌信息]中存在的标准品牌名
- 如果用户提到的品牌在列表中找不到匹配，保留用户原话

## 提取来源约束（applied_position / applied_store）

- 用户主动提出 → 直接提取（如用户说"我想做分拣"→ applied_position: "分拣"）
- 助手推荐后，用户表示感兴趣/确认/认可（如"嗯嗯"、"好的"、"可以"、继续追问该岗位详情）→ 应提取助手推荐的岗位/门店
- 助手推荐后，用户未回应、话题转移、或明确拒绝 → 不提取
- 提取值应为标准岗位名/门店名，去掉口语化后缀（如"的岗位"、"那个店"等）
- 红线：不可从品牌名称中包含的地名推断意向城市/区域。品牌名中的地名是品牌标识，不代表地理限制（如"成都你六姐"是全国连锁，不可推断城市为成都）`;

/** 组装结构化事实提取的用户提示词。 */
export function buildSessionExtractionPrompt(
  brandData: BrandItem[],
  message: string,
  history: string[],
  aliasHints: BrandAliasHint[] = [],
): string {
  const brandInfo =
    brandData.length > 0
      ? brandData
          .map(
            (b) => `- ${b.name}${b.aliases.length > 0 ? `（别称：${b.aliases.join('、')}）` : ''}`,
          )
          .join('\n')
      : '暂无品牌数据';

  const aliasHintInfo =
    aliasHints.length > 0
      ? aliasHints
          .map(
            (hint) =>
              `- 用户原话「${hint.sourceText}」命中别名「${hint.matchedAlias}」=> 标准品牌「${hint.brandName}」`,
          )
          .join('\n')
      : '无';

  return [
    '[可用品牌信息]',
    brandInfo,
    '',
    '[品牌别名命中提示]',
    aliasHintInfo,
    '',
    '[历史对话]',
    history.join('\n') || '无',
    '',
    '[当前消息]',
    message,
  ].join('\n');
}
