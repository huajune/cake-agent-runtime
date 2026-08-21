/**
 * 工具层共享辅助：从最近的聊天历史（按时间升序）中取最后一条用户消息文本。
 */
export function extractLatestUserMessage(
  messages: Array<{ role: string; content: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      return message.content ?? '';
    }
  }
  return '';
}
