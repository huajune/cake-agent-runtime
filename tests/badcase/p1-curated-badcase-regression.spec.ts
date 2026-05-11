import { HardConstraintsSection } from '@agent/context/sections/hard-constraints.section';
import type { PromptContext } from '@agent/context/sections/section.interface';
import { SESSION_EXTRACTION_SYSTEM_PROMPT } from '@memory/services/session-extraction.prompt';
import {
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
} from '@memory/types/session-facts.types';
import { ToolBuildContext } from '@shared-types/tool.types';
import { buildJobListTool } from '@tools/duliday-job-list.tool';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('P1 curated badcase regression batch', () => {
  const section = new HardConstraintsSection();
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  const cloneFallback = (): EntityExtractionResult => ({
    interview_info: { ...FALLBACK_EXTRACTION.interview_info },
    preferences: { ...FALLBACK_EXTRACTION.preferences },
    reasoning: '',
  });

  const renderHardConstraints = (mutate: (facts: EntityExtractionResult) => void): string => {
    const facts = cloneFallback();
    mutate(facts);
    return section.build({ ...baseCtx, sessionFacts: facts });
  };

  describe('tool city gate', () => {
    const mockSpongeService = {
      fetchJobs: jest.fn(),
    };

    const mockContext: ToolBuildContext = {
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: 'sess-1',
      messages: [],
    };

    const defaultInput = {
      cityNameList: [],
      regionNameList: [],
      brandAliasList: [],
      storeNameList: [],
      jobCategoryList: [],
      brandIdList: [],
      projectNameList: [],
      projectIdList: [],
      jobIdList: [],
      location: undefined as
        | {
            longitude?: number;
            latitude?: number;
            range?: number;
          }
        | undefined,
      responseFormat: ['markdown'] as ('markdown' | 'rawData')[],
      includeBasicInfo: true,
      includeJobSalary: false,
      includeWelfare: false,
      includeHiringRequirement: false,
      includeWorkTime: false,
      includeInterviewProcess: false,
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const executeTool = async (input: Record<string, unknown>) => {
      const builder = buildJobListTool(mockSpongeService as never);
      const builtTool = builder(mockContext);
      return builtTool.execute(
        {
          ...defaultInput,
          ...input,
        } as any,
        {
          toolCallId: 'test',
          messages: [],
          abortSignal: undefined as any,
        },
      ) as any;
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    beforeEach(() => jest.clearAllMocks());

    it.each([
      {
        caseId: 'spen553o',
        title: '候选人只说房山，不能无城市直接查区级地点',
        input: { regionNameList: ['房山'] },
      },
      {
        caseId: 'v3nexby8',
        title: '候选人只说远江公寓，不能无城市直接查项目/门店级地点',
        input: { projectNameList: ['远江公寓'] },
      },
      {
        caseId: 'o1intrqf',
        title: '合川 + 万象城存在跨城歧义，运行时必须兜底拦截',
        input: { regionNameList: ['合川'], projectNameList: ['万象城'] },
      },
    ])('$caseId $title', async ({ input }) => {
      const result = await executeTool(input);

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_MISSING_CITY_CONTEXT);
      expect(result.error).toBe(TOOL_ERROR_TYPES.JOB_LIST_MISSING_CITY_CONTEXT);
      expect(result._replyInstruction).toContain('查询前必须先确定候选人所在城市');
      expect(result._replyInstruction).not.toMatch(/上海|北京|杭州|成都|重庆/);
      expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
    });
  });

  describe('hard-constraints facts already extracted by memory', () => {
    it.each([
      {
        caseId: 'jqhr3kku',
        title: '天通苑这类小区/地名应先 geocode，再带 location 查岗位',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.location = ['天通苑'];
        },
        expected: ['位置/商圈/地标: 天通苑', '必须先 geocode', 'location 调 duliday_job_list'],
      },
      {
        caseId: 'spen553o',
        title: '候选人只说房山区域且无城市时必须先确认城市',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.district = ['房山'];
        },
        expected: [
          '区域: 房山',
          '当前没有已确认城市',
          '禁止基于区县通识补 city',
          '确认前不得调用 duliday_job_list',
        ],
      },
      {
        caseId: 'p7nkvvp3',
        title: '候选人岗位开放时不得锁死 jobCategoryList',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.open_position = true;
        },
        expected: ['候选人岗位开放', 'jobCategoryList 必须留空'],
      },
      {
        caseId: '3azxa3pf',
        title: '候选人说五一后再面时禁止主动催面',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.delayed_intent = {
            until: '五一后',
            raw: '五一回来再面试',
          };
        },
        expected: ['推迟意向: 五一后', '禁止主动催面'],
      },
      {
        caseId: '1sy7d9ia',
        title: '候选人说下周再说时禁止主动催面',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.delayed_intent = {
            until: '下周',
            raw: '下周再说吧',
          };
        },
        expected: ['推迟意向: 下周', '禁止主动催面'],
      },
      {
        caseId: 'p5gtueaa',
        title: '短期工意向不得推荐最少工作月数大于等于 1 的岗位',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.short_term = true;
        },
        expected: ['短期工意向', '最少工作月数 ≥ 1 的岗位不得推荐'],
      },
      {
        caseId: '5lujru4j',
        title: '重复短期工 badcase 也纳入批次回归',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.short_term = true;
        },
        expected: ['短期工意向', '最少工作月数 ≥ 1 的岗位不得推荐'],
      },
      {
        caseId: 'ucj8oavx',
        title: '候选人给出 17 点后窗口时岗位班次必须有交集',
        mutate: (facts: EntityExtractionResult) => {
          facts.preferences.time_windows = ['17点后'];
        },
        expected: ['可用时间窗口: 17点后', '工时班次必须与该窗口有交集'],
      },
    ])('$caseId $title', ({ mutate, expected }) => {
      const output = renderHardConstraints(mutate);

      for (const fragment of expected) {
        expect(output).toContain(fragment);
      }
    });
  });

  describe('session-extraction prompt contracts', () => {
    it.each([
      {
        caseId: 'o1intrqf',
        title: '连锁地标禁止凭通识猜城市',
        expected: ['连锁地标名陷阱', '严禁基于通识推断城市', '只填 location，city 留 null'],
      },
      {
        caseId: 'jqhr3kku',
        title: '区/镇/街道/小区级地名单独出现时 city 留 null',
        expected: ['区/镇/街道/小区级地名', 'city 留 null', '只填 district 或 location'],
      },
      {
        caseId: '3ybr183u',
        title: '禁止从明天上班时间反推出明天休息/可面试',
        expected: [
          '禁止推断入事实的红线',
          '明天 9 点到 18 点上班',
          '不得据此推断"明天休息"',
          '这是事实层，不是 reasoning 层',
        ],
      },
    ])('$caseId $title', ({ expected }) => {
      for (const fragment of expected) {
        expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain(fragment);
      }
    });
  });
});
