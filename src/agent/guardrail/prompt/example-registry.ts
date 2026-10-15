import { PLACEHOLDER_PHONES } from '@resolution/candidate/phone';
import { TEST_PII_PHONE_WHITELIST } from '@tools/shared/test-pii-gate';

/** prompt 示例值类别；所有类别都是封闭枚举。 */
export type PromptExampleValueKind = 'person_name' | 'store_name' | 'phone';

export interface PromptExampleValue {
  value: string;
  kind: PromptExampleValueKind;
  /** 为什么该假值可被下游拒收或在观测中稳定识别。 */
  selfDestructsBy: string;
}

/**
 * 模型可见 prompt 的 canary values（占位值）唯一注册表。
 *
 * 模型提示词默认只保留规则，不新增虚构姓名或门店。测试链路必要的号码从既有号码表
 * 投影（候选人域占位号表 + 测试链路假身份白名单），禁止手抄第二份号码。
 */
export const PROMPT_EXAMPLE_REGISTRY: readonly PromptExampleValue[] = [
  ...[...PLACEHOLDER_PHONES].map(
    (value): PromptExampleValue => ({
      value,
      kind: 'phone',
      selfDestructsBy: 'isPlaceholderPhone 拒收',
    }),
  ),
  // 测试链路假身份号（兮兮）：占位门必须放行它，否则 test-suite 的报名/取消复现拿不到
  // 真实网关行为——所以它恰恰不能靠 isPlaceholderPhone 自毁。它只出现在
  // strategySource=testing 分支的工具指引里，且是项目自有测试号，误用只会生成测试工单。
  ...TEST_PII_PHONE_WHITELIST.filter((value) => !PLACEHOLDER_PHONES.has(value)).map(
    (value): PromptExampleValue => ({
      value,
      kind: 'phone',
      selfDestructsBy:
        'test-pii 白名单内的项目自有测试号；生产链路不经过该分支，误用只产生测试工单',
    }),
  ),
];

export const REGISTERED_PROMPT_EXAMPLE_VALUES: ReadonlySet<string> = new Set(
  PROMPT_EXAMPLE_REGISTRY.map((entry) => entry.value),
);
