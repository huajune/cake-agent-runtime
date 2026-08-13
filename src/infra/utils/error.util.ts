/** 从 unknown 提取可读错误信息；非 Error 走 String()。 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 提取错误堆栈，无堆栈时回退到消息。 */
export function toErrorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
