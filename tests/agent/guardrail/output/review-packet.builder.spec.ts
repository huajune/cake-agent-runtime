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
      candidates: ['上海市静安寺'],
    });
    expect(packet.policies.outputRuleHits).toEqual(['confirmed_booking_time_missing']);
  });
});
