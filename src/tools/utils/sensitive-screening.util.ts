/**
 * 敏感筛选信息检测（户籍/籍贯/民族/地域/专业类歧视性条件）。
 *
 * 背景：岗位数据的自由文本（remark / interviewRemark / 面试补充项 / 面试描述等）
 * 可能内嵌"不要新疆西藏籍 / 仅限本地户口 / 限汉族 / 专业（非新媒、食品）"等
 * 歧视性/排除性筛选条件。结构化字段
 * （hometown 块、户籍 banner）渲染时已带 🔒 勿透露标注，但自由文本路径此前没有
 * 针对性标注，只靠全局 prompt 规则兜底。本工具提供统一检测原语：
 * - 渲染层（job-list/render.util）：命中的 section 末尾追加 🔒 标注
 * - precheck 工具：screeningCriteria / screeningChecks 命中时回传 sensitiveScreeningNotice
 *
 * 口径说明：这是**宽口径**检测——岗位自由文本里出现户籍/民族等关键词几乎必然是
 * 筛选条件；误报的代价只是多一行内部提示，对候选人不可见，宁滥勿漏。
 * 出站回复侧（reply-fact-guard）需要窄口径规则避免误伤合规收资话术，不复用本 pattern。
 */

const SENSITIVE_SCREENING_PATTERN = new RegExp(
  [
    // 直接提及户籍/籍贯/民族/本外地人——岗位文本里出现即视为筛选条件
    '户籍',
    '户口',
    '籍贯',
    '民族',
    '本地人',
    '外地人',
    // 排除式："不要 XX 籍 / 谢绝 XX 族 / 不招 XX 相关专业"（XX 为任意地区/民族/专业词）
    '(?:不要|不收|不招|不接受|不考虑|谢绝|拒绝|排除)[^，。；！？\\n]{0,10}?(?:[籍族]|专业)',
    // 圈定式："仅限 XX 籍 / 限 XX 族 / 只招 XX 专业"
    '(?:仅限|只限|只招|只收|限)[^，。；！？\\n]{0,8}?(?:[籍族]|专业)',
    // 专业筛选："专业（非新媒、食品）/ 新媒体相关专业 / 专业要求"——
    // 不用裸词"专业"，避免"专业培训 / 专业的团队"等形容词用法误报
    '专业\\s*[（(]',
    '(?:相关|类|所学)专业',
    '专业(?:要求|限制|背景|不限|不符)',
    '非(?!常)[^，。；！？\\n]{0,10}?专业',
  ].join('|'),
);

/** 文本中是否含户籍/籍贯/民族/地域/专业类敏感筛选信息（宽口径，供岗位数据侧使用）。 */
export function containsSensitiveScreeningText(text: string | null | undefined): boolean {
  if (!text) return false;
  return SENSITIVE_SCREENING_PATTERN.test(text);
}

/** 渲染层 section 级标注：追加在命中敏感词的 section 行尾。 */
export const SENSITIVE_SCREENING_RENDER_NOTICE =
  '- ⚠️ 本节文本含户籍/籍贯/民族/专业等敏感筛选信息，🔒 仅供内部筛选，**严禁向候选人展示或转述**（涉地域/民族/专业歧视，易起纠纷）；判断不符时以排班/距离等中性理由转推其他岗位';

/** precheck 结果级提示：screeningCriteria / screeningChecks 命中敏感词时回传。 */
export const SENSITIVE_SCREENING_CRITERIA_NOTICE =
  '🔒 本岗位筛选条件含户籍/籍贯/民族/专业等敏感信息：仅供内部筛选，严禁把条件本身告诉候选人或写进岗位介绍/拒绝理由（核对专业只能开放式问"你学的什么专业"，严禁反问"专业不是 XX 相关的吧"暴露排除条件）；判断不符时以排班/距离/已招满等中性理由转推其他岗位';
