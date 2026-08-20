import type { BrandItem } from '@/sponge/sponge.types';
import type { BrandAliasHint } from '@resolution/evidence/producers/rule-track';
import type { RuleFactClaims } from '@resolution/evidence/claim.types';
import type { TurnExtractionToolFacts } from '@shared-types/turn.types';
import type { SessionFacts } from '../types/session-facts.types';
import { isSessionFactValue } from '../types/session-facts.types';

export type SessionExtractionToolFacts = TurnExtractionToolFacts;

/**
 * 轮末抽取只负责表单外软事实。
 *
 * 姓名、手机号、性别、年龄等报名资料由 collection form 办结事件写入；抽取模型
 * 不再拥有身份事实写权限，也不输出报名门店、岗位或面试时间等事务字段。
 */
export const SESSION_EXTRACTION_SYSTEM_PROMPT = `你是求职偏好提取引擎。只从候选人本轮表达中提取表单外软事实。

允许输出：
- preferences：brand_ids、salary、position、schedule、city、district、location、labor_form、
  delayed_intent、short_term、open_position、time_windows、schedule_constraint、available_after
- brand_intents：本轮品牌偏好的 positive / negative / browse_all 极性
- labor_form_intent：set / clear / ignore 三态
- reasoning：简短说明；无新信息固定写“本轮无新信息”

硬规则：
1. 禁止输出或推断姓名、手机号、性别、年龄、学历、学生身份、健康证、经历、简历、
   身高、体重、户籍等报名资料。
2. 禁止输出报名门店、报名岗位、面试时间等事务状态。
3. 只采信候选人自己的表达；招聘广告、助手话术、岗位要求不是候选人偏好。
4. 省略表示本轮没有变化；明确撤销/清空时用 labor_form_intent.clear 或相应字段的空值。
5. 城市只接受候选人明示或唯一归属地理线索；同名商圈、品牌名中的地名不得推断城市。
6. position 只记录工种，不能把“咖啡/奶茶/火锅”等品类自动推成具体岗位。
7. brand_intents 只记录本轮新表达；无法链接的排斥可用 brand=null。
8. 相对日期按消息发送时间换算；拿不准就省略，禁止猜测。`;

function formatBrandSection(brandData: BrandItem[], aliasHints: BrandAliasHint[]): string {
  if (brandData.length === 0) return '暂无品牌数据';
  const detailedNames = new Set(aliasHints.map((hint) => hint.brandName));
  const detailed = brandData
    .filter((brand) => detailedNames.has(brand.name))
    .map(
      (brand) =>
        `- ${brand.name}${brand.aliases.length > 0 ? `（别称：${brand.aliases.join('、')}）` : ''}`,
    );
  const names = brandData
    .filter((brand) => !detailedNames.has(brand.name))
    .map((brand) => brand.name);
  return [...detailed, ...(names.length > 0 ? [`其余合作品牌：${names.join('、')}`] : [])].join(
    '\n',
  );
}

function formatKnownPreferences(previousFacts: SessionFacts | null): string | null {
  if (!previousFacts) return null;
  const entries = Object.entries(previousFacts.preferences)
    .filter(([, raw]) => isSessionFactValue(raw) && raw.value !== null)
    .map(([key, raw]) => `- ${key}: ${JSON.stringify(raw.value)}`);
  return entries.length > 0 ? entries.join('\n') : null;
}

/**
 * 保留旧导出名供调用方平滑迁移；身份出处门已退役，因此语料只用于测试/诊断，
 * 不参与事实准入。
 */
export function buildExtractionIdentityProvenanceCorpus(
  message: string,
  history: string[],
  _previousFacts: SessionFacts | null,
): string {
  return [...history, message].filter((part) => part.trim().length > 0).join('\n');
}

export function buildSessionExtractionPrompt(
  brandData: BrandItem[],
  message: string,
  history: string[],
  aliasHints: BrandAliasHint[] = [],
  _ruleFacts: RuleFactClaims | null = null,
  currentTime?: string,
  previousFacts: SessionFacts | null = null,
  _toolFacts: TurnExtractionToolFacts | null = null,
): string {
  const knownPreferences = formatKnownPreferences(previousFacts);
  const aliasHintInfo =
    aliasHints.length > 0
      ? aliasHints
          .map(
            (hint) =>
              `- 用户原话「${hint.sourceText}」命中「${hint.matchedAlias}」=>「${hint.brandName}」`,
          )
          .join('\n')
      : '无';

  return [
    ...(currentTime ? ['[当前时间]', currentTime, ''] : []),
    '[可用品牌信息]',
    formatBrandSection(brandData, aliasHints),
    '',
    '[品牌别名命中提示]',
    aliasHintInfo,
    '',
    ...(knownPreferences ? ['[已有偏好]', knownPreferences, ''] : []),
    '[历史对话]',
    history.join('\n') || '无',
    '',
    '[当前消息]',
    message,
  ].join('\n');
}
