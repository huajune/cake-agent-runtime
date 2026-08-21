import { GuardrailReviewPacketBuilder } from '@agent/guardrail/output/llm/review-packet.builder';
import { createTurnLedger } from '@agent/generator/working-memory/turn-ledger';
import { finalizeVisualFactSheet } from '@resolution/signal/visual';

function visualLedger(raw: { description?: string } & Record<string, unknown>) {
  const ledger = createTurnLedger();
  ledger.recordVisualFacts(finalizeVisualFactSheet(raw, raw.description ?? ''), {
    messageId: 'image-1',
  });
  return ledger;
}

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
            queryMeta: {
              brand: {
                filterMode: 'enforce',
                brandSource: 'model_input',
                appliedBrandIds: [],
                appliedCanonicalNames: ['肯德基'],
                rejected: [{ input: 'Gattouzo', reason: 'unmatched' }],
              },
            },
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
        {
          toolName: 'send_store_location',
          args: { jobId: 101, destination: 'interview' },
          result: {
            success: true,
            destination: 'interview',
            interviewMethod: '线下面试',
            storeName: '东方渔人码头店',
            storeAddress: '东方渔人码头F1楼',
            interviewAddress: '控江旭辉店',
            sentAddress: '控江旭辉店',
            addressConflict: true,
          },
        },
      ],
    });

    expect(packet.latestUserMessages[0]).toMatchObject({
      content: '我在静安寺附近，想看肯德基',
      messageType: 'text',
    });
    // §11 第三切换点：requestedBrands 来自 queryMeta.brand（工具实际应用），
    // 不再读模型原始 args.brandAliasList；被拒绝入参单独暴露。
    expect(packet.evidence.jobList?.requestedBrands).toEqual(['肯德基']);
    expect(packet.evidence.jobList?.rejectedBrandInputs).toEqual(['Gattouzo']);
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
    expect(packet.evidence.sentLocation).toEqual({
      success: true,
      destination: 'interview',
      interviewMethod: '线下面试',
      locationNotRequired: undefined,
      storeName: '东方渔人码头店',
      storeAddress: '东方渔人码头F1楼',
      interviewAddress: '控江旭辉店',
      sentAddress: '控江旭辉店',
      addressConflict: true,
      errorType: undefined,
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

  it('labels exclude-mode brands as excluded instead of requested', () => {
    const packet = builder.build({
      reply: '给你推荐大米先生的岗位',
      userMessage: '别推肯德基了',
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: { brandAliasList: ['肯德基'], brandFilterMode: 'exclude' },
          result: {
            markdown: '# 在招岗位\n大米先生（人民广场店）',
            queryMeta: {
              brand: {
                filterMode: 'exclude',
                brandSource: 'model_input',
                appliedBrandIds: [10001],
                appliedCanonicalNames: ['肯德基'],
                rejected: [],
              },
            },
          },
          resultCount: 1,
          status: 'ok',
        },
      ],
    });

    expect(packet.evidence.jobList?.requestedBrands).toEqual([]);
    expect(packet.evidence.jobList?.excludedBrands).toEqual(['肯德基']);
    expect(packet.evidence.jobList?.args).toEqual({
      brandAliasList: ['肯德基'],
      brandFilterMode: 'exclude',
    });
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

  // 2026-08-04 badcase（trace batch_6a719fde…_1785831840599）：markdown 全长 7372，
  // 达美乐详情段（基础薪资 13.8 元/时）整段落在 4000 字截断点之后，reviewer 只看到
  // 顶部卡片的「0-110 元/天」，把模型正确投递的时薪判成编造。
  it('appends salary sections of truncated job details to the markdown excerpt', () => {
    const markdown = [
      '# 在招岗位（共 3 个）',
      '> 3. **达美乐（大良观绿路分店） - 兼职通岗服务员，5.7km**',
      '>    薪资：0-110 元/天',
      '岗'.repeat(4200), // 模拟前两个岗位详情段撑爆 4000 字窗口
      '## 3. 达美乐-大良观绿路分店-兼职通岗服务员-小时工 (兼职通岗服务员)',
      '### 基本信息',
      '- **品牌**: 达美乐 (ID: 10451)',
      '### 薪资信息',
      '#### 薪资方案 1（正式）',
      '- **结算周期**: 月结算, 5号发薪',
      '- **基础薪资**: 13.8 元/时',
      '- **综合薪资**: 0-110 元/天',
      '- **节假日薪资**: 34.5 元/时',
      '### 福利信息',
      '- **住宿**: 无住宿福利',
      '---',
    ].join('\n');

    const packet = builder.build({
      reply: '附近还有家达美乐，5.7公里，13.8元/时',
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: { cityNameList: ['佛山'] },
          result: { markdown },
          resultCount: 3,
          status: 'ok',
        },
      ],
    });

    const excerpt = packet.evidence.jobList?.markdownExcerpt ?? '';
    expect(excerpt).toContain('（岗位详情已截断）');
    expect(excerpt).toContain('【截断补录·岗位薪资信息】');
    expect(excerpt).toContain('## 3. 达美乐-大良观绿路分店-兼职通岗服务员-小时工');
    expect(excerpt).toContain('- **基础薪资**: 13.8 元/时');
    expect(excerpt).toContain('- **节假日薪资**: 34.5 元/时');
    // 只补薪资段，不把福利等其余详情也带进补录
    expect(excerpt).not.toContain('- **住宿**: 无住宿福利');
  });

  it('does not append salary sections already fully visible in the excerpt window', () => {
    const markdown = [
      '# 在招岗位（共 1 个）',
      '## 1. 必胜客-佛山嘉信PH-餐厅服务员-小时工 (餐厅服务员)',
      '### 薪资信息',
      '- **基础薪资**: 12.8 元/时',
      '### 福利信息',
      '岗'.repeat(5000), // 超长部分全在薪资段之后
    ].join('\n');

    const packet = builder.build({
      reply: '推荐必胜客',
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: {},
          result: { markdown },
          resultCount: 1,
          status: 'ok',
        },
      ],
    });

    const excerpt = packet.evidence.jobList?.markdownExcerpt ?? '';
    expect(excerpt).toContain('（岗位详情已截断）');
    expect(excerpt).not.toContain('【截断补录·岗位薪资信息】');
  });

  // 2026-08-04 审计 P1-6（trace …_1785451709779）：invite_to_group:ok 支撑的
  // "群邀请已经发你了"被零证据档判成"没有任何下发证据"——packet 缺群邀请证据类。
  it('extracts group invite evidence from invite_to_group calls', () => {
    const packet = builder.build({
      reply: '「独立客&上海餐饮兼职13群」的邀请已经发你了，点一下卡片就能进',
      toolCalls: [
        {
          toolName: 'invite_to_group',
          args: { city: '上海' },
          result: { success: true, groupName: '独立客&上海餐饮兼职13群', groupPurpose: 'job_pool' },
          status: 'ok',
        },
      ],
    });

    expect(packet.evidence.groupInvite).toEqual({
      success: true,
      groupName: '独立客&上海餐饮兼职13群',
      alreadyInGroup: undefined,
      errorType: undefined,
    });
  });

  it('keeps invite failure evidence with errorType (not treated as success)', () => {
    const packet = builder.build({
      reply: '好的',
      toolCalls: [
        {
          toolName: 'invite_to_group',
          args: {},
          result: { success: false, errorType: 'invite.group_full' },
          status: 'error',
        },
      ],
    });

    expect(packet.evidence.groupInvite).toMatchObject({
      success: false,
      errorType: 'invite.group_full',
    });
  });

  // badcase 2026-08-06 chat 6a1e42c5 trace …_1785977093673：候选人发后台工单截图，
  // save_image_description 已落档「预约面试时间 2026/08/06 15:00」，助手据此回
  // "你现在是想确认今天15点这个面试对吧"。packet 当时不收该工具 → reviewer 判
  // active_booking_state_conflict「没有任何 booking/precheck 证据显示候选人已预约」。
  describe('视觉事实证据（badcase 6a1e42c5）', () => {
    const screenshotCall = {
      toolName: 'save_image_description',
      args: {
        kind: 'chat_screenshot',
        description:
          '后台工单截图：候选人颜端樟，岗位大米先生-丁香国际-前厅服务-小时工，预约面试时间2026/08/06 15:00',
        fields: [
          { key: 'brand', value: '大米先生', ownership: 'publisher' },
          { key: 'store', value: '丁香国际', ownership: 'publisher' },
          { key: 'other', value: '预约面试时间 2026/08/06 15:00', ownership: 'publisher' },
        ],
      },
      result: { success: true },
      status: 'ok' as const,
    };

    it('把截图结构化字段带进 evidence，并保留 ownership', () => {
      const packet = builder.build({
        reply: '看到了',
        toolCalls: [screenshotCall],
        turnLedger: visualLedger(screenshotCall.args),
      });

      expect(packet.evidence.visualFacts?.sheets).toHaveLength(1);
      expect(packet.evidence.visualFacts?.sheets[0]).toMatchObject({
        kind: 'chat_screenshot',
        fields: [
          { key: 'brand', value: '大米先生', ownership: 'publisher' },
          { key: 'store', value: '丁香国际', ownership: 'publisher' },
          { key: 'other', value: '预约面试时间 2026/08/06 15:00', ownership: 'publisher' },
        ],
      });
    });

    it('内容载体是账本而非 result——result 只有 success 也必须产出证据', () => {
      const packet = builder.build({
        reply: '看到了',
        toolCalls: [screenshotCall],
        turnLedger: visualLedger(screenshotCall.args),
      });
      expect(packet.evidence.visualFacts).toBeDefined();
    });

    it('无图片轮不产出该段', () => {
      const packet = builder.build({ reply: '你好', toolCalls: [] });
      expect(packet.evidence.visualFacts).toBeUndefined();
    });

    it('丢弃 key/value 残缺的字段，全空则整段不产出', () => {
      const packet = builder.build({
        reply: '看到了',
        toolCalls: [
          {
            toolName: 'save_image_description',
            args: { fields: [{ key: 'phone' }, { value: '孤值' }] },
            result: { success: true },
            status: 'ok',
          },
        ],
      });
      expect(packet.evidence.visualFacts).toBeUndefined();
    });

    it('降级 sheet 不进账本时从工具入参回退重建描述证据（PR #1000 评审 P2-9）', () => {
      const packet = builder.build({
        reply: '看到了，这是门店排班表',
        toolCalls: [
          {
            toolName: 'save_image_description',
            args: {
              messageId: 'msg-degraded-1',
              description: '一张门店排班表照片，写着早班 07:00-11:00',
            },
            result: { success: true },
            status: 'ok' as const,
          },
        ],
      });

      expect(packet.evidence.visualFacts?.sheets).toEqual([
        {
          kind: 'other',
          description: '一张门店排班表照片，写着早班 07:00-11:00',
          fields: [],
        },
      ]);
    });

    it('消费工具已 finalize 的账本 sheet：过滤非法 key/证件号、补 ownership并脱敏', () => {
      const idNumber = '310101199001011234';
      const rawSheet = {
        kind: 'resume',
        description: `简历：王建国，身份证号 ${idNumber}`,
        fields: [
          { key: 'phone', value: '13800138000' },
          { key: 'invented_key', value: '不得进入 reviewer' },
          { key: 'other', value: idNumber },
        ],
      };
      const packet = builder.build({
        reply: '看到了',
        turnLedger: visualLedger(rawSheet),
        toolCalls: [
          {
            toolName: 'save_image_description',
            args: rawSheet,
            result: { success: true },
            status: 'ok',
          },
        ],
      });

      expect(packet.evidence.visualFacts?.sheets[0]).toEqual({
        kind: 'resume',
        description: '简历：王建国，身份证号 [身份证号已脱敏]',
        fields: [{ key: 'phone', value: '13800138000', ownership: 'candidate' }],
      });
    });
  });

  it('forwards recent assistant texts for cross-turn restatement adjudication (最近 8 条、单条 600 字截断)', () => {
    const texts = [
      '',
      '   ',
      ...Array.from({ length: 9 }, (_, i) => `往轮回复${i}`),
      `必胜客保利大都汇，日结当天发薪。${'班次详情'.repeat(200)}`,
    ];

    const packet = builder.build({
      reply: '就是昨天说的那家',
      toolCalls: [],
      recentAssistantTexts: texts,
    });

    expect(packet.recentAssistantMessages).toHaveLength(8);
    // 空白条被剔除后取最近 8 条：往轮回复 2..8 + 超长条
    expect(packet.recentAssistantMessages[0]).toBe('往轮回复2');
    const last = packet.recentAssistantMessages.at(-1)!;
    expect(last).toHaveLength(601); // 600 字符 + 截断省略号
    expect(last.startsWith('必胜客保利大都汇，日结当天发薪。')).toBe(true);
    expect(last.endsWith('…')).toBe(true);
  });

  it('defaults recentAssistantMessages to empty array when not provided (repair 等旁路调用方)', () => {
    const packet = builder.build({ reply: '你好', toolCalls: [] });

    expect(packet.recentAssistantMessages).toEqual([]);
  });
});
