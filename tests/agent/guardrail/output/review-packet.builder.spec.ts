import { GuardrailReviewPacketBuilder } from '@agent/guardrail/output/llm/review-packet.builder';

describe('GuardrailReviewPacketBuilder', () => {
  const builder = new GuardrailReviewPacketBuilder();

  it('extracts job/precheck/booking/geocode evidence from tool calls', () => {
    const packet = builder.build({
      reply: '已帮你约好明天下午面试',
      userMessage: '我在静安寺附近，想看肯德基',
      redLines: ['不要主动提保险'],
      outputRuleHits: ['confirmed_booking_time_missing'],
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: {
            brandAliasList: ['肯德基'],
            cityNameList: ['上海'],
            jobCategoryList: [],
            pageNum: 1,
            pageSize: 20,
            location: { longitude: 121.44, latitude: 31.22, range: 5000 },
          },
          result: {
            result: [
              {
                jobId: 101,
                brandName: '肯德基',
                basicInfo: {
                  storeInfo: { storeName: '静安寺店', address: '南京西路' },
                },
                _distanceKm: 0.8,
                jobSalary: { baseSalary: '24元/小时' },
              },
            ],
          },
          resultCount: 1,
          status: 'ok',
        },
        {
          toolName: 'duliday_interview_precheck',
          args: {},
          result: {
            nextAction: 'collect_fields',
            bookingChecklist: {
              requiredFieldsToCollectNow: ['姓名', '电话'],
              missingFields: ['姓名'],
              collectionStrategy: { starterFields: ['姓名', '电话', '年龄'] },
            },
            interview: { interviewTimeMode: 'fixed_slots' },
          },
        },
        {
          toolName: 'duliday_interview_booking',
          args: {},
          result: {
            success: true,
            workOrderId: 'wo-1',
            _confirmedInterviewTimeHuman: '明天 14:00',
            _onSiteScript: '到店说独立客招聘介绍',
          },
        },
        {
          toolName: 'geocode',
          args: {},
          result: {
            resolution: 'ambiguous',
            confidence: 'low',
            candidates: [{ formattedAddress: '上海市静安寺' }],
          },
        },
      ],
    });

    expect(packet.latestUserMessages[0]).toMatchObject({
      content: '我在静安寺附近，想看肯德基',
      messageType: 'text',
    });
    expect(packet.evidence.jobList?.requestedBrands).toEqual(['肯德基']);
    expect(packet.evidence.jobList?.hasEvidence).toBe(true);
    // args 只保留查询意图白名单：分页/坐标不透传，空数组剔除，距离召回压成布尔标记。
    expect(packet.evidence.jobList?.args).toEqual({
      brandAliasList: ['肯德基'],
      cityNameList: ['上海'],
      locationBasedRecall: true,
    });
    expect(packet.evidence.jobList?.jobs[0]).toMatchObject({
      jobId: 101,
      brandName: '肯德基',
      storeName: '静安寺店',
      distanceKm: 0.8,
      address: '南京西路',
    });
    expect(packet.evidence.precheck).toMatchObject({
      nextAction: 'collect_fields',
      requiredFieldsToCollectNow: ['姓名', '电话'],
      starterFields: ['姓名', '电话', '年龄'],
      missingFields: ['姓名'],
      interviewTimeMode: 'fixed_slots',
    });
    expect(packet.evidence.booking).toMatchObject({
      success: true,
      confirmedInterviewTimeHuman: '明天 14:00',
      onSiteScript: '到店说独立客招聘介绍',
    });
    expect(packet.evidence.geocode).toMatchObject({
      resolution: 'ambiguous',
      confidence: 'low',
      hasResolvedCoordinate: false,
      candidates: ['上海市静安寺'],
    });
    expect(packet.policies.outputRuleHits).toEqual(['confirmed_booking_time_missing']);
  });

  it('falls back to markdown excerpt when job_list returns markdown-only (enforce 前必修：readJobListJobs 读不懂 markdown)', () => {
    const markdown =
      '# 在招岗位（共 2 个）\n\n> 📣 推荐对话用模板\n> 1. **成都你六姐（亚繁亚乐城店） - 后厨，9km**\n>    薪资：24元/时起\n';
    const packet = builder.build({
      reply: '给你推荐成都你六姐后厨，24元/时起',
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: { cityNameList: ['上海'] },
          result: { markdown },
          resultCount: 2,
          status: 'ok',
        },
      ],
    });

    expect(packet.evidence.jobList?.jobs).toEqual([]);
    expect(packet.evidence.jobList?.hasEvidence).toBe(true);
    expect(packet.evidence.jobList?.markdownExcerpt).toContain('成都你六姐（亚繁亚乐城店）');
    expect(packet.evidence.jobList?.markdownExcerptChars).toBeGreaterThan(0);
  });

  it('keeps resolved geocode coordinates even when candidates are empty', () => {
    const packet = builder.build({
      reply: '顺德这边有岗位',
      toolCalls: [
        {
          toolName: 'geocode',
          args: {},
          result: {
            result: {
              city: '佛山市',
              district: '顺德区',
              latitude: 22.805413,
              longitude: 113.293197,
              areaLevelQuery: true,
              formattedAddress: '广东省佛山市顺德区顺德区顺德区',
            },
            resolution: 'unique',
          },
        },
      ],
    });

    expect(packet.evidence.geocode).toMatchObject({
      resolution: 'unique',
      formattedAddress: '广东省佛山市顺德区顺德区顺德区',
      latitude: 22.805413,
      longitude: 113.293197,
      areaLevelQuery: true,
      hasResolvedCoordinate: true,
      candidates: [],
    });
  });

  it('prefers the latest USABLE job_list call over a trailing empty recheck（守卫档案 id=3 同型链路）', () => {
    const packet = builder.build({
      reply: '有必胜客在招',
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: { cityNameList: ['佛山'] },
          result: { markdown: '# 在招岗位（共 1 个）\n必胜客（丹灶店）- 服务员，11.4元/时' },
          resultCount: 1,
          status: 'ok',
        },
        {
          toolName: 'duliday_job_list',
          args: { cityNameList: ['佛山'] },
          result: { success: false, errorType: 'job_list.no_results' },
          resultCount: 0,
          status: 'empty',
        },
      ],
    });

    expect(packet.evidence.jobList?.status).toBe('ok');
    expect(packet.evidence.jobList?.hasEvidence).toBe(true);
    expect(packet.evidence.jobList?.markdownExcerpt).toContain('必胜客（丹灶店）');
  });

  it('truncates oversized markdown evidence', () => {
    const packet = builder.build({
      reply: '推荐岗位',
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: {},
          result: { markdown: `# 在招岗位\n${'岗'.repeat(6000)}` },
          resultCount: 1,
          status: 'ok',
        },
      ],
    });

    const excerpt = packet.evidence.jobList?.markdownExcerpt ?? '';
    expect(excerpt.length).toBeLessThan(4100);
    expect(excerpt).toContain('（岗位详情已截断）');
  });
});
