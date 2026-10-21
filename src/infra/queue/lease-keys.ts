/** Shared by live conversation processing and background reconciliation; Redis adds the environment prefix. */
export function conversationProcessingLeaseKey(chatId: string): string {
  return `wecom:message:lock:${chatId}`;
}
