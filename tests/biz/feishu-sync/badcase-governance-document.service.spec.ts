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
                    content: '7 月 28 日 18:45：BadCase 治理更新',
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
