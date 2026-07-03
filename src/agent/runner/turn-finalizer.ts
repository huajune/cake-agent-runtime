/**
 * 回合记忆收尾句柄（agent 层）。
 *
 * 封装 `deferTurnEnd` 闭包的编排不变式，使调用方（渠道）只需上报**投递结局**这一个它本就
 * 负责的事实，不必再懂记忆领域的规则：「未送达不投影助手轮次 / replay 丢弃首版 / 处理锁
 * 释放前 await 落盘」。这些规则此前散落在渠道编排里，属于分层泄漏。
 *
 * 典型用法：
 * ```ts
 * const finalizer = TurnFinalizer.from(runnerResult.runTurnEnd, (e) => logger.warn(e));
 * finalizer.discard();                 // replay：首版回复未发出，承载的记忆投影必须一并丢弃
 * finalizer.settle({ delivered });     // 投递结局已知后触发；delivered=false 只记用户侧记忆
 * await finalizer.whenSettled();       // 处理锁释放前等待落盘，杜绝跨 job 并发覆盖
 * ```
 */
export class TurnFinalizer {
  private run?: (opts?: { includeAssistantText?: boolean }) => Promise<void>;
  private pending?: Promise<void>;

  private constructor(
    run: ((opts?: { includeAssistantText?: boolean }) => Promise<void>) | undefined,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.run = run;
  }

  /**
   * 包装 runner 暴露的 `runTurnEnd` 闭包（`deferTurnEnd` 时存在；否则返回一个空操作句柄）。
   */
  static from(
    run: ((opts?: { includeAssistantText?: boolean }) => Promise<void>) | undefined,
    onError?: (error: unknown) => void,
  ): TurnFinalizer {
    return new TurnFinalizer(run, onError);
  }

  /**
   * 投递结局已知后触发记忆收尾。幂等：仅首次调用生效。
   *
   * `delivered=false`（守卫拦截 / 主动沉默 / 投递失败 / 托管暂停）时只记用户侧记忆，不把
   * 未送达的回复投影成助手轮次，避免下一轮「幽灵复聊」。
   */
  settle(opts: { delivered: boolean }): void {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    this.pending = run({ includeAssistantText: opts.delivered }).catch((error) => {
      this.onError?.(error);
    });
  }

  /**
   * replay 丢弃首版：首次回复未发出，其承载的记忆投影/事实提取必须一并丢弃，否则会把
   * 「未送达的回复」污染进 session 记忆。丢弃后 {@link settle} / {@link whenSettled} 均为空操作。
   */
  discard(): void {
    this.run = undefined;
  }

  /**
   * 处理锁释放前等待收尾落盘，保证同一 chat 的记忆写入相对处理锁串行——若收尾仍在异步写
   * session state 时锁已释放，会与下一个 job 的读写并发，整份覆盖写互相丢更新。
   */
  async whenSettled(): Promise<void> {
    if (this.pending) await this.pending;
  }
}
