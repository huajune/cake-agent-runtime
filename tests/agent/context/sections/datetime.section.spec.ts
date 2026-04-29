import { DateTimeSection } from '@/agent/context/sections/datetime.section';

describe('DateTimeSection', () => {
  beforeEach(() => {
    // 04-29 周三 16:02 上海 — badcase bgsjb64r 的日期场景
    jest.useFakeTimers().setSystemTime(new Date('2026-04-29T08:02:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders relative date table grounded on system time', () => {
    const section = new DateTimeSection();
    const output = section.build({ scenario: 'candidate-consultation' } as never);

    const lines = output.split('\n');
    expect(lines[0].startsWith('当前时间：')).toBe(true);
    expect(output).toContain('今天：2026-04-29 星期三');
    expect(output).toContain('明天：2026-04-30 星期四');
    expect(output).toContain('后天：2026-05-01 星期五');
    expect(output).toContain('大后天：2026-05-02 星期六');
  });

  it('uses provided currentTimeText when available without changing relative dates', () => {
    const section = new DateTimeSection();
    const output = section.build({
      scenario: 'candidate-consultation',
      currentTimeText: '2026/04/29 星期三 16:02',
    } as never);

    expect(output.split('\n')[0]).toBe('当前时间：2026/04/29 星期三 16:02');
    expect(output).toContain('今天：2026-04-29 星期三');
    expect(output).toContain('后天：2026-05-01 星期五');
  });
});
