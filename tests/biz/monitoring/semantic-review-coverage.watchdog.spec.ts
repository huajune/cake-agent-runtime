import { SemanticReviewCoverageWatchdog } from '@biz/monitoring/services/alerts/semantic-review-coverage.watchdog';

/**
 * 语义评审覆盖率看门狗——2026-07-29 语义评审停摆 4h50m 无告警的补丁。
 *
 * 判据是「成功回合数够多 且 语义评审落库为 0」，三个分支都要有回归：
 * 停摆命中、有评审不告警、低峰量能不告警。
 */
describe('SemanticReviewCoverageWatchdog', () => {
  const buildWatchdog = (successfulTurns: number, semanticReviews: number) => {
    const countSuccessfulTurnsBetween = jest.fn().mockResolvedValue(successfulTurns);
    const countSemanticReviewsBetween = jest.fn().mockResolvedValue(semanticReviews);
    const sendSimpleAlert = jest.fn().mockResolvedValue(true);
    const watchdog = new SemanticReviewCoverageWatchdog(
      { countSuccessfulTurnsBetween } as never,
      { countSemanticReviewsBetween } as never,
      { sendSimpleAlert } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
    );
    return { watchdog, countSuccessfulTurnsBetween, countSemanticReviewsBetween, sendSimpleAlert };
  };

  it('alerts when a busy hour produced zero semantic reviews', async () => {
    const { watchdog, sendSimpleAlert } = buildWatchdog(651, 0);

    await watchdog.checkPreviousHourCoverage();

    expect(sendSimpleAlert).toHaveBeenCalledTimes(1);
    const [title, body] = sendSimpleAlert.mock.calls[0];
    expect(title).toContain('语义评审');
    expect(body).toContain('651');
  });

  it('stays silent when semantic reviews were produced', async () => {
    const { watchdog, sendSimpleAlert } = buildWatchdog(651, 12);

    await watchdog.checkPreviousHourCoverage();

    expect(sendSimpleAlert).not.toHaveBeenCalled();
  });

  // 夜间/周末低峰本来就可能整小时零评审；按低峰量能告警只会训练出"狼来了"。
  it('stays silent below the minimum turn volume, without even querying reviews', async () => {
    const { watchdog, sendSimpleAlert, countSemanticReviewsBetween } = buildWatchdog(4, 0);

    await watchdog.checkPreviousHourCoverage();

    expect(countSemanticReviewsBetween).not.toHaveBeenCalled();
    expect(sendSimpleAlert).not.toHaveBeenCalled();
  });

  it('queries exactly the previous whole hour', async () => {
    const { watchdog, countSuccessfulTurnsBetween } = buildWatchdog(100, 5);

    await watchdog.checkPreviousHourCoverage();

    const [from, to] = countSuccessfulTurnsBetween.mock.calls[0];
    expect(to.getTime() - from.getTime()).toBe(60 * 60 * 1000);
    expect(to.getMinutes()).toBe(0);
    expect(to.getSeconds()).toBe(0);
    expect(to.getMilliseconds()).toBe(0);
  });

  it('never throws when the database call fails', async () => {
    const { watchdog, sendSimpleAlert } = buildWatchdog(0, 0);
    (
      watchdog as never as { recordRepository: { countSuccessfulTurnsBetween: jest.Mock } }
    ).recordRepository.countSuccessfulTurnsBetween.mockRejectedValue(new Error('db down'));

    await expect(watchdog.checkPreviousHourCoverage()).resolves.toBeUndefined();
    expect(sendSimpleAlert).not.toHaveBeenCalled();
  });
});
