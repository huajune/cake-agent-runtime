import { BadcaseGovernanceDocumentService } from '@biz/feishu-sync/badcase-governance-document.service';

/**
 * 治理文档的统计数字刷新：追加式写入只动「三、」，一/五 两处静态数字不跟着改就会逐日变假。
 */
describe('BadcaseGovernanceDocumentService - 统计数字刷新', () => {
  const documentId = 'docx-1';
  const text = (id: string, content: string, blockType = 2) => ({
    block_id: id,
    parent_id: documentId,
    block_type: blockType,
    [blockType === 12 ? 'bullet' : blockType === 4 ? 'heading2' : 'text']: {
      elements: [{ text_run: { content } }],
    },
  });

  const childIds = [
    'h1',
    'intro',
    'updated-at',
    'h3',
    'daily-entry',
    'h4',
    'h5',
    'five-intro',
    'five-a',
    'five-b',
    'five-c',
  ];
  const blocks = [
    { block_id: documentId, block_type: 1, children: childIds },
    text('h1', '一、整体进展', 4),
    text('intro', '目前 BadCase 池累计约 630 个运营反馈，……当前剩余 55 个未解决问题。'),
    text('updated-at', '更新时间：2026 年 7 月 28 日'),
    text('h3', '三、主要治理批次', 4),
    // 批次流水里也会出现「待分析：3 个」这类字样，刷新时绝不能命中这里
    text('daily-entry', '待分析：3 个转运营，处理中：1 个待发版', 12),
    text('h4', '四、近两周状态清账说明', 4),
    text('h5', '五、当前剩余问题', 4),
    text('five-intro', '目前剩余 55 个未解决问题，状态为：'),
    text('five-a', '待分析：22 个；', 12),
    text('five-b', '处理中：17 个；', 12),
    text('five-c', '待验证：16 个。', 12),
  ];

  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'true';
      return fallback;
    }),
  };
  const feishuApi = { get: jest.fn(), post: jest.fn(), patch: jest.fn() };
  const service = new BadcaseGovernanceDocumentService(config as never, feishuApi as never);

  const patchedText = (blockId: string): string | undefined => {
    const call = feishuApi.patch.mock.calls.find(([url]) => (url as string).endsWith(blockId));
    return call?.[1]?.update_text_elements?.elements?.[0]?.text_run?.content;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks 只清调用记录，不还原 mockImplementation——开关必须每例重设
    config.get.mockImplementation((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'true';
      return fallback;
    });
    feishuApi.get
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            node: {
              obj_type: 'docx',
              obj_token: documentId,
              title: 'BadCase 治理进展同步',
              space_id: 'space-1',
            },
          },
        },
      })
      .mockResolvedValueOnce({ data: { code: 0, data: { items: blocks, has_more: false } } });
    feishuApi.patch.mockResolvedValue({ data: { code: 0, msg: 'success' } });
  });

  it('把一、五两处的剩余数与三态分布改写成真实值', async () => {
    const result = await service.refreshSummary({
      items: [],
      occurredAt: new Date('2026-07-30T02:00:00.000Z'),
      summaryCounts: { 待分析: 26, 处理中: 20, 待验证: 14 },
    });

    expect(result).toEqual(
      expect.objectContaining({ attempted: true, total: 60, updatedBlocks: 6 }),
    );
    expect(patchedText('intro')).toContain('当前剩余 60 个未解决问题');
    expect(patchedText('intro')).toContain('累计约 630 个运营反馈');
    expect(patchedText('updated-at')).toBe('更新时间：2026 年 7 月 30 日');
    expect(patchedText('five-intro')).toBe('目前剩余 60 个未解决问题，状态为：');
    expect(patchedText('five-a')).toBe('待分析：26 个；');
    expect(patchedText('five-b')).toBe('处理中：20 个；');
    expect(patchedText('five-c')).toBe('待验证：14 个。');
  });

  it('不碰「三、主要治理批次」里长得像统计的流水条目', async () => {
    await service.refreshSummary({
      items: [],
      summaryCounts: { 待分析: 26, 处理中: 20, 待验证: 14 },
    });

    expect(patchedText('daily-entry')).toBeUndefined();
  });

  it('未提供统计数时不发任何写请求', async () => {
    const result = await service.refreshSummary({ items: [] });

    expect(result).toEqual({ attempted: false, updatedBlocks: 0, total: 0 });
    expect(feishuApi.patch).not.toHaveBeenCalled();
    expect(feishuApi.get).not.toHaveBeenCalled();
  });

  it('开关关闭时只做 dry-run，不写文档', async () => {
    config.get.mockImplementation((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'false';
      return fallback;
    });

    const result = await service.refreshSummary({
      items: [],
      summaryCounts: { 待分析: 26, 处理中: 20, 待验证: 14 },
    });

    expect(result).toEqual(expect.objectContaining({ attempted: true, updatedBlocks: 0 }));
    expect(feishuApi.patch).not.toHaveBeenCalled();
  });

  it('调用方给了稳定 eventId 时用它做幂等键，命中即跳过追加但仍对齐数字', async () => {
    const withEvent = [...blocks, text('old-event', '治理事件ID：bcg-daily-triage-20260730')];
    feishuApi.get.mockReset();
    feishuApi.get.mockImplementation((url: string) =>
      url.includes('/wiki/')
        ? Promise.resolve({
            data: {
              code: 0,
              data: {
                node: {
                  obj_type: 'docx',
                  obj_token: documentId,
                  title: 'x',
                  space_id: 's',
                },
              },
            },
          })
        : Promise.resolve({ data: { code: 0, data: { items: withEvent, has_more: false } } }),
    );

    const result = await service.appendUpdate({
      items: [{ recordId: 'rec-1', status: '处理中' }],
      eventId: 'bcg-daily-triage-20260730',
      summaryCounts: { 待分析: 26, 处理中: 20, 待验证: 14 },
    });

    expect(result.skipped).toBe(true);
    expect(result.eventId).toBe('bcg-daily-triage-20260730');
    expect(feishuApi.post).not.toHaveBeenCalled();
    expect(result.summary?.updatedBlocks).toBe(6);
  });
});

/**
 * 抬头数字藏在高亮块（callout）里（2026-08-06 实测缺陷）。
 *
 * 旧实现只扫根级 children，而文档抬头的「当前剩余 N 个未解决问题」与「更新时间：…」
 * 写在 callout 内部——callout 自身没有文本、文本挂在它的 children 上，正则永远匹配
 * 不到，抬头数字长期停在首次写入的值（正文已刷成 39，抬头仍是 65）。
 */
describe('BadcaseGovernanceDocumentService - 抬头在高亮块内也要刷新', () => {
  const documentId = 'docx-1';
  const node = (id: string, content: string, blockType = 2, extra = {}) => ({
    block_id: id,
    block_type: blockType,
    [blockType === 12 ? 'bullet' : blockType === 4 ? 'heading2' : 'text']: {
      elements: [{ text_run: { content } }],
    },
    parent_id: documentId,
    ...extra,
  });

  const blocks = [
    {
      block_id: documentId,
      block_type: 1,
      children: ['callout', 'h1', 'h3', 'h4', 'h5', 'five-intro'],
    },
    // callout 自身无文本，抬头两行是它的 children
    { block_id: 'callout', block_type: 19, children: ['intro', 'updated-at'] },
    node('intro', '目前 BadCase 池累计约 686 个运营反馈，当前剩余 65 个未解决问题。'),
    node('updated-at', '更新时间：2026 年 7 月 31 日'),
    node('h1', '一、整体进展', 4),
    node('h3', '三、主要治理批次', 4),
    node('h4', '四、近两周状态清账说明', 4),
    node('h5', '五、当前剩余问题', 4),
    node('five-intro', '目前剩余 65 个未解决问题，状态为：'),
  ];

  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'true';
      return fallback;
    }),
  };
  const feishuApi = { get: jest.fn(), post: jest.fn(), patch: jest.fn() };
  const service = new BadcaseGovernanceDocumentService(config as never, feishuApi as never);

  const patchedText = (blockId: string): string | undefined => {
    const call = feishuApi.patch.mock.calls.find(([url]) => (url as string).endsWith(blockId));
    return call?.[1]?.update_text_elements?.elements?.[0]?.text_run?.content;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    feishuApi.get.mockImplementation((url: string) => {
      if (url.includes('get_node')) {
        return Promise.resolve({
          data: {
            code: 0,
            data: { node: { obj_type: 'docx', obj_token: documentId, title: 'T' } },
          },
        });
      }
      return Promise.resolve({ data: { code: 0, data: { items: blocks } } });
    });
    feishuApi.patch.mockResolvedValue({ data: { code: 0, msg: 'success' } });
  });

  it('刷新时能改到 callout 内部的剩余数与更新时间', async () => {
    const result = await service.refreshSummary({
      occurredAt: new Date('2026-08-06T02:00:00.000Z'),
      items: [],
      summaryCounts: { 待分析: 27, 处理中: 6, 待验证: 6 },
    });

    expect(result.attempted).toBe(true);
    expect(result.total).toBe(39);
    expect(patchedText('intro')).toContain('当前剩余 39 个未解决问题');
    expect(patchedText('updated-at')).toBe('更新时间：2026 年 8 月 6 日');
    expect(patchedText('five-intro')).toContain('目前剩余 39 个未解决问题');
  });
});
