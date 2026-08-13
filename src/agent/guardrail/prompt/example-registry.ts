import { PLACEHOLDER_PHONES } from '@resolution/candidate/phone';

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
 * 新增虚构人名、门店或号码前必须先登记；号码只从候选人域占位号表投影，避免词表漂移。
 */
export const PROMPT_EXAMPLE_REGISTRY: readonly PromptExampleValue[] = [
  {
    value: '测试娟',
    kind: 'person_name',
    selfDestructsBy: '姓名形状门拒绝「测试」前缀',
  },
  {
    value: '粪叉',
    kind: 'person_name',
    selfDestructsBy: '仅作昵称反例；禁止进入候选人姓名事实',
  },
  {
    value: '测试门店',
    kind: 'store_name',
    selfDestructsBy: '「测试」前缀可稳定识别，且不对应生产门店',
  },
  ...[...PLACEHOLDER_PHONES].map(
    (value): PromptExampleValue => ({
      value,
      kind: 'phone',
      selfDestructsBy: 'isPlaceholderPhone 拒收',
    }),
  ),
];

export const REGISTERED_PROMPT_EXAMPLE_VALUES: ReadonlySet<string> = new Set(
  PROMPT_EXAMPLE_REGISTRY.map((entry) => entry.value),
);
