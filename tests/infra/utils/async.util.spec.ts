import { exponentialBackoffMs, sleep, sleepUnref } from '@infra/utils/async.util';

describe('async.util', () => {
  describe('sleep / sleepUnref', () => {
    it('resolves after the requested delay', async () => {
      jest.useFakeTimers();
      try {
        let done = false;
        const pending = sleep(50).then(() => {
          done = true;
        });
        jest.advanceTimersByTime(49);
        await Promise.resolve();
        expect(done).toBe(false);
        jest.advanceTimersByTime(1);
        await pending;
        expect(done).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('sleepUnref unrefs its timer so it never holds the process open', async () => {
      const unref = jest.fn();
      const spy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((handler: TimerHandler): NodeJS.Timeout => {
          if (typeof handler === 'function') handler();
          return { unref } as unknown as NodeJS.Timeout;
        });
      try {
        await sleepUnref(1000);
        expect(unref).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('exponentialBackoffMs', () => {
    it('doubles per attempt starting at the base (attempt 从 1 起)', () => {
      expect(exponentialBackoffMs(1, 100, 10_000)).toBe(100);
      expect(exponentialBackoffMs(2, 100, 10_000)).toBe(200);
      expect(exponentialBackoffMs(3, 100, 10_000)).toBe(400);
    });

    it('clamps to max', () => {
      expect(exponentialBackoffMs(10, 100, 1_000)).toBe(1_000);
    });

    it('treats attempt 0 / 负数 as the first attempt（不返回小于 base 的退避）', () => {
      expect(exponentialBackoffMs(0, 100, 10_000)).toBe(100);
      expect(exponentialBackoffMs(-5, 100, 10_000)).toBe(100);
    });
  });
});
