import { scanJobPages, buildScannedQueryError } from '@tools/job-list/scan-jobs.util';
import { WorkTimeContractError } from '@sponge/work-time.types';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
const page = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ basicInfo: { jobId: start + i } }));

describe('岗位有界补页', () => {
  it('取得第二页，保留上游总数及扫描计数', async () => {
    const fetch = jest.fn().mockResolvedValue({ jobs: page(21, 2), total: 22 });
    const out = await scanJobPages(
      { jobs: page(1, 20), total: 22 },
      { cityNameList: ['上海'] },
      fetch,
      Date.now() + 15000,
    );
    expect(out.meta).toMatchObject({
      upstreamTotal: 22,
      scannedCount: 22,
      scannedPages: 2,
      scanComplete: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ cityNameList: ['上海'], pageNum: 2, pageSize: 20 }),
      expect.any(AbortSignal),
    );
  });
  it('第十页停止，不把200条误报成总量250条已查完', async () => {
    const fetch = jest
      .fn()
      .mockImplementation(async ({ pageNum }) => ({
        jobs: page((pageNum - 1) * 20 + 1, 20),
        total: 250,
      }));
    const out = await scanJobPages(
      { jobs: page(1, 20), total: 250 },
      {},
      fetch,
      Date.now() + 15000,
    );
    expect(out.meta).toMatchObject({
      upstreamTotal: 250,
      scannedCount: 200,
      scannedPages: 10,
      scanComplete: false,
      stopReason: 'page_limit',
    });
  });
  it('时间耗尽不再发下一页', async () => {
    const fetch = jest.fn();
    expect(
      (await scanJobPages({ jobs: page(1, 20), total: 40 }, {}, fetch, Date.now() - 1)).meta
        .stopReason,
    ).toBe('time_budget');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['empty_page', []],
    ['duplicate_page', page(1, 20)],
  ])('提前%s保持部分扫描', async (reason, jobs) => {
    const out = await scanJobPages(
      { jobs: page(1, 20), total: 40 },
      {},
      jest.fn().mockResolvedValue({ jobs, total: 40 }),
      Date.now() + 15000,
    );
    expect(out.meta).toMatchObject({ scanComplete: false, stopReason: reason });
  });
  it('后续网络失败保留部分结果，契约错误整次失败', async () => {
    expect(
      (
        await scanJobPages(
          { jobs: page(1, 20), total: 40 },
          {},
          jest.fn().mockRejectedValue(new Error('offline')),
          Date.now() + 15000,
        )
      ).meta.stopReason,
    ).toBe('page_error');
    await expect(
      scanJobPages(
        { jobs: page(1, 20), total: 40 },
        {},
        jest.fn().mockRejectedValue(new WorkTimeContractError('invalid')),
        Date.now() + 15000,
      ),
    ).rejects.toThrow(WorkTimeContractError);
  });
  it('查询过程中total变化不能声称完整', async () => {
    const out = await scanJobPages(
      { jobs: page(1, 20), total: 40 },
      {},
      jest.fn().mockResolvedValue({ jobs: page(21, 20), total: 39 }),
      Date.now() + 15000,
    );
    expect(out.meta).toMatchObject({ scanComplete: false, stopReason: 'total_changed' });
  });
  it('未知班次或未查完移除确定性无岗话术', () => {
    const meta = {
      upstreamTotal: 40,
      scannedCount: 20,
      scannedPages: 1,
      scanComplete: false,
      stopReason: 'page_limit' as const,
    };
    const args = {
      errorType: TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
      replyInstruction: '无岗',
      details: { noMatchScript: { candidateMessage: '附近没岗位' } },
    };
    expect(buildScannedQueryError(args, meta, [])).not.toHaveProperty('noMatchScript');
    expect(
      buildScannedQueryError(args, { ...meta, scanComplete: true }, [
        { jobId: 1, reason: '待确认' },
      ]),
    ).not.toHaveProperty('noMatchScript');
  });
});
