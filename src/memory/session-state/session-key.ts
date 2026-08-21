/** session facts Redis hash key 的唯一构造器。 */
export function buildSessionFactsHashKey(
  corpId: string,
  userId: string,
  sessionId: string,
): string {
  return `factsv2:${corpId}:${userId}:${sessionId}`;
}
