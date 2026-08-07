import { BadcaseGovernanceDocumentService } from '@biz/feishu-sync/badcase-governance-document.service';

describe('BadcaseGovernanceDocumentService', () => {
  const documentId = 'docx-1';
  const sectionFourId = 'section-four';
  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'false';
      return fallback;
    }),
  };
  const feishuApi = {
    get: jest.fn(),
    post: jest.fn(),
  };
  const service = new BadcaseGovernanceDocumentService(config as never, feishuApi as never);

  const blocks = [
    {
      block_id: documentId,
      block_type: 1,
      children: ['section-three', 'latest-update', sectionFourId],
    },
    {
      block_id: 'section-three',
      parent_id: documentId,
      block_type: 4,
      heading2: { elements: [{ text_run: { content: '三、主要治理批次' } }] },
    },
    {
      block_id: 'latest-update',
      parent_id: documentId,
      block_type: 5,
      heading3: { elements: [{ text_run: { content: '7 月 28 日：补充验证' } }] },
    },
    {
      block_id: sectionFourId,
      parent_id: documentId,
      block_type: 4,
      heading2: { elements: [{ text_run: { content: '四、近两周状态清账说明' } }] },
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'false';
      return fallback;
    });
    feishuApi.get
      .mockResolvedValueOnce({
        data: {
          code: 0,
          msg: 'success',
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
      .mockResolvedValueOnce({
        data: {
          code: 0,
          msg: 'success',
          data: { items: blocks, has_more: false },
        },
      });
  });

  it('resolves the wiki document and finds the insertion point before section four', async () => {
    await expect(service.checkAccess()).resolves.toEqual({
      success: true,
      title: 'BadCase 治理进展同步',
      documentId,
      blockCount: 4,
      insertionIndex: 2,
    });
  });

  it('returns a dry-run preview without writing when sync is disabled', async () => {
    const result = await service.appendUpdate({
      occurredAt: new Date('2026-07-28T10:45:00.000Z'),
      items: [
        {
          recordId: 'rec-1',
          badcaseId: 'BC-1',
          category: '地区/位置/距离',
          title: '模糊区域追问',
          status: '已解决',
          batchId: 'batch-1',
          evidenceSummary: '总判定：passed',
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, skipped: false, dryRun: true }),
    );
    expect(feishuApi.post).not.toHaveBeenCalled();
  });

  it('inserts a dated update before section four when sync is enabled', async () => {
    config.get.mockImplementation((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'true';
      return fallback;
    });
    feishuApi.post.mockResolvedValue({ data: { code: 0, msg: 'success', data: {} } });

    const result = await service.appendUpdate({
      occurredAt: new Date('2026-07-28T10:45:00.000Z'),
      items: [{ recordId: 'rec-1', status: '待验证', batchId: 'batch-1' }],
    });

    expect(result.dryRun).toBe(false);
    expect(feishuApi.post).toHaveBeenCalledWith(
      `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      expect.objectContaining({
        index: 2,
        children: expect.arrayContaining([
          expect.objectContaining({
            heading3: expect.objectContaining({
              elements: [
                expect.objectContaining({
                  text_run: expect.objectContaining({
                    content: '7 月 28 日：BadCase 治理更新',
                  }),
                }),
              ],
            }),
          }),
        ]),
      }),
      { params: { document_revision_id: -1 } },
    );
  });
});

/**
 * 按日聚合（2026-08-06）。
 *
 * 旧实现按「月 日 时:分」建小节标题，单日跑 11 次巡检就堆出 20 个小节，同一条 case
 * 在不同小节里状态互相矛盾，运营从上往下读看不出最终状态。改为同日共用一个小节：
 * 已存在当日小节时只追加条目，插到该小节末尾（下一个根级标题之前）。
 */
describe('BadcaseGovernanceDocumentService — 按日聚合', () => {
  const documentId = 'docx-1';
  const sectionFourId = 'section-four';
  const config = { get: jest.fn() };
  const feishuApi = { get: jest.fn(), post: jest.fn(), patch: jest.fn() };
  let service: BadcaseGovernanceDocumentService;

  /** 根级顺序：三、 / 当日小节 / 当日已有条目 / 四、 */
  const blocksWithToday = [
    {
      block_id: documentId,
      block_type: 1,
      children: ['section-three', 'today-heading', 'today-item', sectionFourId],
    },
    {
      block_id: 'section-three',
      parent_id: documentId,
      block_type: 4,
      heading2: { elements: [{ text_run: { content: '三、主要治理批次' } }] },
    },
    {
      block_id: 'today-heading',
      parent_id: documentId,
      block_type: 5,
      heading3: { elements: [{ text_run: { content: '7 月 28 日：BadCase 治理更新' } }] },
    },
    {
      block_id: 'today-item',
      parent_id: documentId,
      block_type: 12,
      bullet: { elements: [{ text_run: { content: '未分类｜rec-0：已解决' } }] },
    },
    {
      block_id: sectionFourId,
      parent_id: documentId,
      block_type: 4,
      heading2: { elements: [{ text_run: { content: '四、近两周状态清账说明' } }] },
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((key: string, fallback?: string) => {
      if (key === 'FEISHU_BADCASE_GOVERNANCE_WIKI_TOKEN') return 'wiki-1';
      if (key === 'BADCASE_GOVERNANCE_DOC_SYNC_ENABLED') return 'true';
      return fallback;
    });
    feishuApi.get.mockImplementation((url: string) => {
      if (url.includes('get_node')) {
        return Promise.resolve({
          data: {
            code: 0,
            data: { node: { obj_type: 'docx', obj_token: documentId, title: 'T' } },
          },
        });
      }
      return Promise.resolve({ data: { code: 0, data: { items: blocksWithToday } } });
    });
    feishuApi.post.mockResolvedValue({ data: { code: 0, msg: 'success', data: {} } });
    service = new BadcaseGovernanceDocumentService(config as never, feishuApi as never);
  });

  it('当日小节已存在时只追加条目，不再新建标题', async () => {
    await service.appendUpdate({
      occurredAt: new Date('2026-07-28T10:45:00.000Z'),
      eventId: 'evt-second-run',
      items: [{ recordId: 'rec-1', status: '待验证' }],
      refreshSummary: false,
    });

    const [, body] = feishuApi.post.mock.calls[0];
    const children = body.children as Array<Record<string, unknown>>;
    // 不含 heading3、不含「本次更新：」——只有条目与事件 ID
    expect(children.some((b) => 'heading3' in b)).toBe(false);
    expect(JSON.stringify(children)).not.toContain('本次更新：');
    expect(JSON.stringify(children)).toContain('rec-1');
    expect(JSON.stringify(children)).toContain('evt-second-run');
    // 插到当日小节末尾＝「四、」所在下标 3，而不是文末
    expect(body.index).toBe(3);
  });

  it('当日还没有小节时新建（标题不含时分）', async () => {
    await service.appendUpdate({
      occurredAt: new Date('2026-07-29T10:45:00.000Z'),
      eventId: 'evt-new-day',
      items: [{ recordId: 'rec-2', status: '已解决' }],
      refreshSummary: false,
    });

    const [, body] = feishuApi.post.mock.calls[0];
    const payload = JSON.stringify(body.children);
    expect(payload).toContain('7 月 29 日：BadCase 治理更新');
    expect(payload).not.toMatch(/\d{2}:\d{2}：BadCase/);
    expect(payload).toContain('本次更新：');
  });

  it('同一事件 ID 重复运行仍然跳过，不会重复追加', async () => {
    const res = await service.appendUpdate({
      occurredAt: new Date('2026-07-28T10:45:00.000Z'),
      eventId: '未分类｜rec-0', // 已存在于当日条目文本中
      items: [{ recordId: 'rec-9', status: '已解决' }],
      refreshSummary: false,
    });
    expect(res.skipped).toBe(true);
    expect(feishuApi.post).not.toHaveBeenCalled();
  });
});
