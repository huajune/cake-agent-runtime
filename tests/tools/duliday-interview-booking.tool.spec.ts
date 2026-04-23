import {
  buildCustomerLabelList,
  findScreeningFailure,
  resolveInterviewType,
  type BuildCustomerLabelListParams,
  type BuildCustomerLabelListResult,
} from '@tools/duliday-interview-booking.tool';
import type { SpongeInterviewSupplementDefinition } from '@sponge/sponge-job.util';
import type { JobDetail } from '@sponge/sponge.types';
import type { ToolBuildContext } from '@shared-types/tool.types';

function makeParams(
  override: Partial<BuildCustomerLabelListParams> = {},
): BuildCustomerLabelListParams {
  return {
    supplementDefinitions: [],
    context: {} as ToolBuildContext,
    name: '王玉凯',
    phone: '15669826812',
    age: 32,
    genderId: 1,
    interviewTime: '2026-04-21 16:00:00',
    ...override,
  };
}

function healthCertDefinition(
  labelName: string,
): SpongeInterviewSupplementDefinition {
  return { labelId: 13, labelName, name: labelName };
}

type SuccessResult = Extract<BuildCustomerLabelListResult, { success: true }>;
type FailureResult = Extract<BuildCustomerLabelListResult, { success: false }>;

function expectSuccess(result: BuildCustomerLabelListResult): SuccessResult {
  expect(result.success).toBe(true);
  return result as SuccessResult;
}

function expectFailure(result: BuildCustomerLabelListResult): FailureResult {
  expect(result.success).toBe(false);
  return result as FailureResult;
}

describe('buildCustomerLabelList — hasHealthCertificate 回填', () => {
  // Regression: 批次 batch_6937c6929d6d3a463be8d93b_1776679140981 里，
  // 岗位要求的 supplement 标签叫"有无健康证"，首次调用只传了 hasHealthCertificate
  // 未传 supplementAnswers，旧正则仅匹配"健康证情况"，导致首次必挂。
  const commonVariants = ['有无健康证', '是否有健康证', '健康证情况', '健康证'];

  commonVariants.forEach((labelName) => {
    it(`labelName="${labelName}" 时应从 hasHealthCertificate 自动回填`, () => {
      const result = expectSuccess(
        buildCustomerLabelList(
          makeParams({
            supplementDefinitions: [healthCertDefinition(labelName)],
            hasHealthCertificate: 1,
          }),
        ),
      );

      expect(result.customerLabelList).toEqual([
        { labelId: 13, labelName, name: labelName, value: '有' },
      ]);
    });
  });

  it('labelName="健康证类型" 应走 healthCertificateTypes 回填，不被健康证正则截胡', () => {
    const result = expectSuccess(
      buildCustomerLabelList(
        makeParams({
          supplementDefinitions: [
            { labelId: 14, labelName: '健康证类型', name: '健康证类型' },
          ],
          healthCertificateTypes: [1],
        }),
      ),
    );

    expect(result.customerLabelList[0].value).toBe('食品健康证');
  });

  it('未传 hasHealthCertificate 时，应明确报缺失', () => {
    const result = expectFailure(
      buildCustomerLabelList(
        makeParams({
          supplementDefinitions: [healthCertDefinition('有无健康证')],
        }),
      ),
    );

    expect(result.errorType).toBe('missing_customer_label_values');
    expect(result.missingSupplementLabels).toEqual(['有无健康证']);
  });

  it('supplementAnswers 用别名 key 也能命中', () => {
    const result = expectSuccess(
      buildCustomerLabelList(
        makeParams({
          supplementDefinitions: [healthCertDefinition('有无健康证')],
          supplementAnswers: { 健康证: '有' },
        }),
      ),
    );

    expect(result.customerLabelList[0].value).toBe('有');
  });
});

describe('resolveInterviewType', () => {
  function makeJob(firstInterview: Record<string, unknown> | null | undefined): JobDetail {
    return {
      interviewProcess: firstInterview ? { firstInterview } : {},
    } as unknown as JobDetail;
  }

  it('desc 里含 "ai" 时，统一归类为 AI面试', () => {
    const job = makeJob({ firstInterviewWay: '线上面试', firstInterviewDesc: '线上ai面试' });
    expect(resolveInterviewType(job)).toBe('AI面试');
  });

  it('desc 的 "AI" 匹配大小写不敏感', () => {
    const job = makeJob({ firstInterviewWay: '线上面试', firstInterviewDesc: 'AI 视频面试' });
    expect(resolveInterviewType(job)).toBe('AI面试');
  });

  it('没有 AI 信号时，以 firstInterviewWay 为准', () => {
    expect(resolveInterviewType(makeJob({ firstInterviewWay: '线上面试' }))).toBe('线上面试');
    expect(resolveInterviewType(makeJob({ firstInterviewWay: '线下面试' }))).toBe('线下面试');
  });

  it('firstInterview 缺失或字段为空时返回 undefined', () => {
    expect(resolveInterviewType(makeJob(null))).toBeUndefined();
    expect(resolveInterviewType(makeJob({}))).toBeUndefined();
    expect(resolveInterviewType(makeJob({ firstInterviewWay: '   ' }))).toBeUndefined();
  });
});

describe('findScreeningFailure', () => {
  it('returns null when supplementAnswers is undefined or empty', () => {
    expect(findScreeningFailure(undefined)).toBeNull();
    expect(findScreeningFailure({})).toBeNull();
  });

  it('ignores collect-type labels even if answer looks suspicious', () => {
    expect(
      findScreeningFailure({
        学历: '食品类专业本科', // collect 类，不做筛选
        能干几个月: '不一定',
      }),
    ).toBeNull();
  });

  it('catches blacklist violation (badcase 69e9bba2)', () => {
    const result = findScreeningFailure({
      '专业（非新媒、食品）': '食品类',
    });
    expect(result).toEqual({
      label: '专业（非新媒、食品）',
      answer: '食品类',
      matched: '食品',
    });
  });

  it('catches rhetorical-style negative answer (badcase 69e9bba2)', () => {
    const result = findScreeningFailure({
      周四六日都能上班吗: '不一定',
    });
    expect(result).toEqual({
      label: '周四六日都能上班吗',
      answer: '不一定',
      matched: '不一定',
    });
  });

  it('catches 是否学生（不要学生） when candidate self-identifies as student', () => {
    // 候选人明确提到"学生"关键词才触发；模糊的"是，在读大三"要靠 Agent 继续追问
    const result = findScreeningFailure({
      '是否学生（不要学生）': '我是大三学生',
    });
    expect(result?.label).toBe('是否学生（不要学生）');
    expect(result?.matched).toBe('学生');
  });

  it('passes when all screening answers are acceptable', () => {
    expect(
      findScreeningFailure({
        '是否学生（不要学生）': '社会人士',
        '专业（非新媒、食品）': '会计',
        周四六日都能上班吗: '可以',
        一周能上几天班: '3天', // collect 类会被跳过
      }),
    ).toBeNull();
  });

  it('skips empty or whitespace-only answers', () => {
    expect(
      findScreeningFailure({
        '专业（非新媒、食品）': '   ',
      }),
    ).toBeNull();
  });
});
