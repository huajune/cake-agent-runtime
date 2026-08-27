import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { FactRule } from '../output-rule.types';

const SENSITIVE_ATTRIBUTE =
  '(?:户籍|户口|籍贯|本地人|少数民族|维吾尔族|哈萨克族|蒙古族|朝鲜族|婚育|婚姻|已婚|未婚|已育|未育|备孕|[^，。；！？?\\n]{1,8}专业)';
const DISCRIMINATORY_LEAK_PATTERN = new RegExp(
  `(?:不要|不收|不招|不接受|不考虑|谢绝|拒绝|排除|仅限|只限|只招|只收)[^，。；！？?\\n]{0,10}${SENSITIVE_ATTRIBUTE}|${SENSITIVE_ATTRIBUTE}[^，。；！？?\\n]{0,8}(?:不符|不匹配|有硬性要求|有限制)|(?:结婚了吗|有没有孩子|婚育情况)`,
  'u',
);
const ORIGIN_PROBE_PATTERN =
  /(?:老家|籍贯|户籍|户口)[^。！？?\n]{0,6}(?:是)?(?:哪|什么地方|何处)|(?:哪里人|哪儿人|哪边人|哪个省的人|什么地方的人)|本地人(?:吗|吧|么|呢|\?|？)/u;

export const DISCRIMINATION_LEAK_RULES: FactRule[] = [
  {
    ruleId: 'discriminatory_screening_leak',
    label: '回复以户籍、民族、专业或婚育等敏感属性限招、拒收或解释不匹配',
    keywords: DISCRIMINATORY_LEAK_PATTERN,
    requiredToolPredicate: () => false,
    action: GUARDRAIL_ACTION.BLOCK,
  },
  {
    ruleId: 'sensitive_origin_probe',
    label: '回复主动打听候选人的籍贯、老家或是否本地人',
    keywords: ORIGIN_PROBE_PATTERN,
    requiredToolPredicate: () => false,
    action: GUARDRAIL_ACTION.BLOCK,
  },
];
