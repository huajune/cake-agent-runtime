import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { stripTimeContext } from '@resolution/signal/markers';
import { buildToolError, TOOL_ERROR_TYPES } from './shared/tool-error-types';

const logger = new Logger('skip_reply');

/**
 * 场景一确定性准入（2026-10-19 BadCase 复核 [05]，trace batch_6ad093aace406a6aeec4fee0_1792054200262）：
 * 候选人首句「我是星空」，模型 reason 自述「不符合 skip_reply 条件，应正常回复」却仍以
 * confirmation_closure 调用，工具一接受即整轮静默，候选人等了 51 分钟。两条运行时判据：
 * - 消息窗口里必须已有经理侧（assistant）消息——首句没有可收尾的推进动作；
 * - 当前消息剥掉已知表情/占位/语音转写标记、空白与标点后不足 10 字，且不含问句标记。
 * 近 14 天 1,681 次场景一静默：10 次无任何经理侧回复、89 次原文 ≥10 字（多为「好的，谢谢您，非常感谢」
 * 一类礼貌长尾，按剥标点后计数绝大多数仍放行）、24 次带问句词。
 */
const CONFIRMATION_MAX_CHARS = 10;
/**
 * 已登记的封闭问句标记，不是完整问句识别器；未覆盖的问句语义仍由模型按工具契约判断。
 * 「呢」刻意不收（「好呢」「好的呢」是高频确认口癖）。
 */
const QUESTION_MARKER_PATTERN =
  /[?？]|吗|怎么|什么|哪|多少|多久|为什么|几点|几号|几天|能不能|可不可以|行不行|是不是/u;
/** 只剥已知表情与平台占位格式，普通括号中的用户内容必须参与问句和长度检查。 */
const BRACKET_TOKEN_PATTERN =
  /[\[【](?:抱拳|表情消息|图片消息(?:\s+\d+\s+张)?|语音转文字(?:[，,]\s*时长\d+秒)?)[\]】]/gu;

function normalizeAckText(text: string): string {
  return stripTimeContext(text)
    .replace(BRACKET_TOKEN_PATTERN, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 只校验短句形状，不裁决确认语义；是否存在新诉求仍由模型按工具契约判断。 */
export function isShortConfirmationMessage(text: string): boolean {
  const stripped = stripTimeContext(text).replace(BRACKET_TOKEN_PATTERN, '');
  if (QUESTION_MARKER_PATTERN.test(stripped)) return false;
  const normalized = normalizeAckText(text);
  return normalized.length > 0 && [...normalized].length < CONFIRMATION_MAX_CHARS;
}

function hasAssistantMessage(messages: readonly unknown[]): boolean {
  return messages.some(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { role?: unknown }).role === 'assistant',
  );
}

function extractMessageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** 当前候选人消息：优先 turnInput.currentUserMessage，缺省取消息窗口末尾连续 user 块。 */
function resolveCurrentUserText(turnInput: {
  messages: readonly unknown[];
  currentUserMessage?: string;
}): string {
  const current = turnInput.currentUserMessage?.trim();
  if (current) return current;
  const trailing: string[] = [];
  for (let i = turnInput.messages.length - 1; i >= 0; i -= 1) {
    const message = turnInput.messages[i];
    if ((message as { role?: unknown })?.role !== 'user') break;
    trailing.unshift(extractMessageText(message));
  }
  return trailing.join('\n').trim();
}

/** 工具和空回复信封共用确认收尾准入；这里只裁决历史与消息形状。 */
export function getConfirmationClosureRejection(turnInput: {
  messages: readonly unknown[];
  currentUserMessage?: string;
}): string | null {
  if (!hasAssistantMessage(turnInput.messages)) {
    return TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NO_PRIOR_TURN;
  }
  if (!isShortConfirmationMessage(resolveCurrentUserText(turnInput))) {
    return TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK;
  }
  return null;
}

const DESCRIPTION = `主动跳过本轮回复（什么都不发）。调用后 runtime 会短路消息发送，但仍记录本轮流水。

## 合法调用场景（满足任一场景即应调用）

### 场景一：确认词收尾（scene=confirmation_closure，三条全部满足）
1. 候选人本轮消息为纯确认词（好的/好/谢谢/嗯/收到/ok/okk/好吧 等），长度 < 10 字符，**不含问句结构**；
2. 上一轮你已完成明确推进动作：已推荐岗位 / 发了面试模板 / 已拉群 / 已发送面试确认；
3. 本轮没有新的待确认线索或候选人诉求变化。

### 场景二：真人招募经理正在沟通（scene=human_takeover）
候选人当前消息之前**最近一条经理侧消息**带【内部来源标记：真人招募经理手动发送】，且候选人本轮是在**回应这条真人消息**，且未带出新的业务诉求（新问题/新地点/新岗位类型）→ 必须调用 skip_reply 把对话让给真人，不要插话。
边界：只看最近一条经理侧消息。你自己（Agent）回复过之后，候选人的下一条就是发给你的，更早历史里的真人标记不构成让位理由；runtime 会按消息来源校验该条件，不成立时本工具返回 \`skipped=false\` 并拒绝沉默，此时必须正常回复候选人，不得改用其他场景再次沉默。
场景一同样有 runtime 准入：对话里还没有任何经理侧消息（候选人首句），或当前消息剥标记、空白与标点后为空、达到 10 字、含问句标记时，本工具返回 \`skipped=false\`，必须正常回复。通过准入仍须满足场景一全部条件，短句本身不代表确认收尾。
注意：若候选人在回应真人的同时提出了需要你处理的新诉求（问岗位/要地址/要改约等），则正常接管回复，不适用本场景。

## 想沉默只有这一条通道
判断本轮不该回复时，**唯一**合法动作是调用本工具。**严禁**用文本形式表达沉默，不得输出括号旁白或说明文字，那会被当成正文直接发给候选人。

## 禁止调用场景
- 候选人首句（没有上轮铺垫）
- 候选人提新问题 / 新诉求 / 新地点 / 新岗位类型
- 候选人表达情绪（不满、催促、质疑、粗口等）→ 用 raise_risk_alert
- 同轮还需要调用其它业务工具（duliday_* / invite_to_group / send_store_location 等）

## 硬规则
- 本轮调用 skip_reply 后，**不得再输出任何文本回复**，也不得再调用其它工具
- skip_reply 与 raise_risk_alert / request_handoff 互斥：有风险应走告警而非沉默
- scene 必填，只能是上述两个场景之一；reason 必填，简短说明为什么沉默（便于复盘）

## 执行效果
- 本轮不给候选人发任何消息
- 流水仍写入 message_processing_records（deliveryState=skipped_intentional）
- 监控可统计"主动沉默率"`;

export const SKIP_REPLY_SCENES = ['confirmation_closure', 'human_takeover'] as const;

const inputSchema = z.object({
  scene: z
    .enum(SKIP_REPLY_SCENES)
    .describe(
      '沉默场景：confirmation_closure=候选人纯确认词收尾；human_takeover=真人招募经理正在沟通（runtime 按消息来源校验）',
    ),
  reason: z.string().min(1).describe('为何沉默：用简短中文描述本轮实际触发条件'),
});

/**
 * skip_reply 工具
 *
 * 副作用型工具：调用后本轮不再生成对外消息。
 * 与 raise_risk_alert / request_handoff 同类——不产生对话回复，只落观测指标。
 *
 * 使用场景一：候选人回复仅为纯确认词（好的/好/谢谢/嗯/收到/ok），
 * 且上一轮你已完成明确推进（给岗位、发模板、拉群、面试确认），
 * 本轮继续主动回复反而显得生硬。
 *
 * 使用场景二：真人招募经理手动接管沟通、候选人正在回应真人时，通过本工具静默让位。
 * 没有这个合法出口时，模型会把"（AI 保持静默）"旁白当正文发给候选人。
 *
 * 场景二由 runtime 确定性校验：`turnInput.humanTakeoverActive`（候选人当前消息之前最近一条
 * 经理侧消息是否真人手动发送）不成立时拒绝沉默，返回 buildToolError（skipped=false、不短路），
 * 模型必须继续正常回复；generator 的 prepareStep 会在拒绝后屏蔽本工具，防止换场景再试。
 * 场景一由 runtime 校验两条准入（见 isShortConfirmationMessage）：消息窗口里已有经理侧消息，
 * 且当前消息非空、不足 10 字、不含问句标记；任一不成立同样 buildToolError 拒绝。
 * 这只是沉默的必要条件，短句是否为纯确认、上轮是否已推进仍由主 Agent 判断。
 * 接受时返回 `skipped=true` + `shortCircuited=true`，生成链路据此短路，不再依赖工具名特判。
 */
export function buildSkipReplyTool(): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ scene, reason }) => {
        const chatId = context.session.chatId ?? context.session.sessionId;
        const trimmedReason = reason.trim();

        if (scene === 'human_takeover' && context.turnInput.humanTakeoverActive !== true) {
          logger.warn(
            `skip_reply 拒绝: scene=human_takeover 但最近一条经理侧消息非真人手动发送, chatId=${chatId}, userId=${context.session.userId}, reason=${trimmedReason}`,
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.SKIP_REPLY_HUMAN_TAKEOVER_NOT_ACTIVE,
            replyInstruction:
              '候选人当前消息之前最近一条经理侧消息是你自己（Agent）发出的，不存在真人正在沟通；候选人这条消息是发给你的，本轮必须正常回复，不得再次调用 skip_reply。',
            details: { skipped: false, scene, reason: trimmedReason },
          });
        }

        if (scene === 'confirmation_closure') {
          const rejection = getConfirmationClosureRejection(context.turnInput);
          if (rejection === TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NO_PRIOR_TURN) {
            logger.warn(
              `skip_reply 拒绝: scene=confirmation_closure 但消息窗口无任何经理侧消息（候选人首句）, chatId=${chatId}, userId=${context.session.userId}, reason=${trimmedReason}`,
            );
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NO_PRIOR_TURN,
              replyInstruction:
                '候选人这是首句，你还没有回复过对方，不存在可收尾的推进动作；本轮必须正常开场回复，不得再次调用 skip_reply。',
              details: { skipped: false, scene, reason: trimmedReason },
            });
          }
          if (rejection === TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK) {
            const currentUserText = resolveCurrentUserText(context.turnInput);
            logger.warn(
              `skip_reply 拒绝: scene=confirmation_closure 但当前消息不是短确认词, chatId=${chatId}, userId=${context.session.userId}, message="${currentUserText.slice(0, 40)}", reason=${trimmedReason}`,
            );
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK,
              replyInstruction:
                '候选人当前消息为空、达到 10 字或含问句标记，不满足确认收尾的运行时准入；本轮必须正常回复，不得再次调用 skip_reply。',
              details: { skipped: false, scene, reason: trimmedReason },
            });
          }
        }

        logger.log(
          `skip_reply: chatId=${chatId}, userId=${context.session.userId}, scene=${scene}, reason=${trimmedReason}`,
        );

        return {
          skipped: true,
          shortCircuited: true,
          scene,
          reason: trimmedReason,
          instruction: '本轮不得再输出任何文本，也不得调用其他工具；直接结束本轮。',
        };
      },
    });
  };
}
