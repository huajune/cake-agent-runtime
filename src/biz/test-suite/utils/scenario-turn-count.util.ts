interface ScenarioHistoryMessage {
  role?: unknown;
  content?: unknown;
}

const USER_ROLE_ALIASES = new Set(['user', 'candidate', 'customer']);
const USER_ROLE_PATTERN = /(候选|求职|客户|用户|boss)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isUserMessage(message: unknown): message is ScenarioHistoryMessage {
  const record = asRecord(message);
  if (!record) return false;

  const role = readString(record.role)?.toLowerCase();
  if (role && USER_ROLE_ALIASES.has(role)) return true;
  if (role && USER_ROLE_PATTERN.test(role)) return true;

  return false;
}

/**
 * 用例测试的对话轮数按候选人/用户发言次数计算，并把当前待测消息计为最新一轮。
 */
export function countScenarioDialogueTurns(testInput: unknown, inputMessage?: unknown): number {
  const input = asRecord(testInput);
  const history = Array.isArray(input?.history) ? input.history : [];
  const currentMessage = readString(input?.message) ?? readString(inputMessage);

  const historyUserTurns = history.filter(isUserMessage).length;
  const currentAlreadyInHistory =
    Boolean(currentMessage) &&
    history.some((message) => {
      if (!isUserMessage(message)) return false;
      return readString(message.content) === currentMessage;
    });

  return historyUserTurns + (currentMessage && !currentAlreadyInHistory ? 1 : 0);
}
