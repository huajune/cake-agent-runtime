import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { FactRule } from '../output-rule.types';

/**
 * 虚假承诺规则。
 *
 * 职责：
 * - 管“Agent 对候选人承诺了一个没有任何工具信号能正当化的状态”的场景；
 * - 目前只剩名额承诺：这类承诺一旦发出即成证据，风险不可逆。
 *
 * 动作策略：
 * - quota_promise 用 block：名额承诺没有任何工具能正当化，发出去风险不可逆；
 *   runner 会先尝试一次重写，二审仍违规才静默。
 *
 * 2026-07-10 用户裁定批量下线（勿修补勿重加）：group_full_without_invite（未拉群编造群满）、
 * system_status_fabrication（系统状态甩锅观察）、tool_failure_success_claim（副作用工具失败
 * 反向声称成功对账）随本批删除；detectCompletionSuccessClaimWithoutTool（复聊完成时态对账）
 * 自 ReengagementAgent 取代 composer 后已无消费方，作为死代码一并清理。句粒度“声称”判定
 * 原语（原 claim-assertion.util 内联版）随最后一个消费者退场。
 */

// 注意：`还` 后面的承诺后缀必须命中其一——不能整组可选，否则裸子串"名额还"就会命中，
// 把"名额还在不在我这边没法保证"这类合规免责话术一起硬拦。
const QUOTA_PROMISE_PATTERN =
  /名额(?:放心|不会满|还(?:有很多|有不少|够了?)|充足|给你留|帮你留|专门给你|留够了)|帮你(?:留(?!意)|保留)(?:好了|着)?(?:名额|位置)?|你(?:的|那个)?名额(?:还在(?!不在)|有的|没满)|名额不会满的/;

export const FALSE_PROMISE_RULES: FactRule[] = [
  {
    ruleId: 'quota_promise',
    label:
      '回复向候选人承诺名额不会满或已保留（承诺一旦发出即成证据，岗位状态可能随时变化，候选人有前置成本时需提示不确定性）',
    keywords: QUOTA_PROMISE_PATTERN,
    requiredToolPredicate: () => false,
    action: GUARDRAIL_ACTION.BLOCK,
  },
];
