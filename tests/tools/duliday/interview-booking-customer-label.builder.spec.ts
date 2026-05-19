import {
  buildCustomerLabelList,
  type BuildCustomerLabelListParams,
  type BuildCustomerLabelListResult,
} from '@tools/duliday/booking/interview-booking-customer-label.builder';
import type { SpongeInterviewSupplementDefinition } from '@sponge/sponge-job.util';
import { SPONGE_CUSTOMER_LABEL_MAX_LENGTH } from '@sponge/sponge.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import type { ToolBuildContext } from '@shared-types/tool.types';

type SuccessResult = Extract<BuildCustomerLabelListResult, { success: true }>;
type FailureResult = Extract<BuildCustomerLabelListResult, { success: false }>;

function expectSuccess(result: BuildCustomerLabelListResult): asserts result is SuccessResult {
  if (!result.success) {
    throw new Error('expected success but got failure');
  }
}

function expectFailure(result: BuildCustomerLabelListResult): asserts result is FailureResult {
  if (result.success) {
    throw new Error('expected failure but got success');
  }
}

function def(labelName: string, labelId = labelName.length): SpongeInterviewSupplementDefinition {
  return { labelId, labelName, name: labelName };
}

function baseContext(override: Partial<ToolBuildContext> = {}): ToolBuildContext {
  return {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
    ...override,
  };
}

function baseParams(
  override: Partial<BuildCustomerLabelListParams> = {},
): BuildCustomerLabelListParams {
  return {
    supplementDefinitions: [],
    context: baseContext(),
    name: '张三',
    phone: '13800000000',
    age: 23,
    genderId: 1,
    interviewTime: '2026-05-13 10:00',
    ...override,
  };
}

describe('buildCustomerLabelList', () => {
  describe('boundary cases', () => {
    it('returns empty list when supplementDefinitions is empty', () => {
      const result = buildCustomerLabelList(baseParams());

      expectSuccess(result);
      expect(result.customerLabelList).toEqual([]);
      expect(result.customerLabelDefinitions).toEqual([]);
    });

    it('returns BOOKING_MISSING_CUSTOMER_LABEL_VALUES when a label cannot be resolved', () => {
      const definitions = [def('完全不认识的字段')];
      const result = buildCustomerLabelList(
        baseParams({ supplementDefinitions: definitions }),
      );

      expectFailure(result);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES);
      expect(result.missingSupplementLabels).toEqual(['完全不认识的字段']);
      expect(result.error).toContain('完全不认识的字段');
    });

    it('returns BOOKING_INVALID_CUSTOMER_LABEL_VALUES with the max-length constant when value is too long', () => {
      const longText = 'a'.repeat(SPONGE_CUSTOMER_LABEL_MAX_LENGTH + 1);
      const definitions = [def('身份')];
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: definitions,
          supplementAnswers: { 身份: longText },
        }),
      );

      expectFailure(result);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_CUSTOMER_LABEL_VALUES);
      expect(result.invalidSupplementLabels).toEqual(['身份']);
      // error 文案必须引用常量值（而非硬编码字面量），防止常量与文案脱节
      expect(result.error).toContain(String(SPONGE_CUSTOMER_LABEL_MAX_LENGTH));
    });

    it('prefers MISSING over INVALID when both happen in the same batch', () => {
      const definitions = [def('未知字段'), def('身份')];
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: definitions,
          supplementAnswers: { 身份: 'a'.repeat(SPONGE_CUSTOMER_LABEL_MAX_LENGTH + 1) },
        }),
      );

      expectFailure(result);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES);
    });
  });

  describe('resolveCustomerLabelValue branches', () => {
    it('takes supplementAnswers value first, overriding the typed param', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [def('身高')],
          supplementAnswers: { 身高: '175' },
          height: 999,
        }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('175');
    });

    it('resolves 学历 from educationId via sponge enum mapping', () => {
      const result = buildCustomerLabelList(
        baseParams({ supplementDefinitions: [def('学历')], educationId: 2 }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('本科');
    });

    it('returns missing when 学历 label appears but educationId is absent', () => {
      const result = buildCustomerLabelList(
        baseParams({ supplementDefinitions: [def('学历')] }),
      );

      expectFailure(result);
      expect(result.missingSupplementLabels).toEqual(['学历']);
    });

    it('resolves 籍贯/户籍 from householdRegisterProvinceId', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [def('籍贯')],
          householdRegisterProvinceId: 310000,
        }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('上海市');
    });

    it('resolves 身高/体重 from numeric params', () => {
      const heightResult = buildCustomerLabelList(
        baseParams({ supplementDefinitions: [def('身高')], height: 175 }),
      );
      expectSuccess(heightResult);
      expect(heightResult.customerLabelList[0].value).toBe('175');

      const weightResult = buildCustomerLabelList(
        baseParams({ supplementDefinitions: [def('体重')], weight: 65 }),
      );
      expectSuccess(weightResult);
      expect(weightResult.customerLabelList[0].value).toBe('65');
    });

    it('matches 健康证类型 before falling back to 健康证 branch', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [def('健康证类型')],
          healthCertificateTypes: [1, 2],
        }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('食品健康证、零售健康证');
    });

    it('resolves 健康证 aliases ("有无健康证") via hasHealthCertificate', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [def('有无健康证')],
          hasHealthCertificate: 1,
        }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('有');
    });

    it('resolves 身份 from context.sessionFacts.interview_info.is_student', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [def('身份')],
          context: baseContext({
            sessionFacts: {
              interview_info: { is_student: true },
            },
          } as Partial<ToolBuildContext>),
        }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('学生');
    });

    it('falls back to context.profile.is_student when sessionFacts has no signal', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [def('身份')],
          context: baseContext({
            profile: { is_student: false },
          } as Partial<ToolBuildContext>),
        }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('社会人士');
    });

    it('resolves basic labels (姓名/电话/性别/年龄/面试时间) from typed params', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [
            def('姓名', 1),
            def('电话', 2),
            def('性别', 3),
            def('年龄', 4),
            def('面试时间', 5),
          ],
        }),
      );

      expectSuccess(result);
      const byName = Object.fromEntries(
        result.customerLabelList.map((label) => [label.labelName, label.value]),
      );
      expect(byName['姓名']).toBe('张三');
      expect(byName['电话']).toBe('13800000000');
      expect(byName['性别']).toBe('男');
      expect(byName['年龄']).toBe('23');
      expect(byName['面试时间']).toBe('2026-05-13 10:00');
    });

    it('treats 联系方式 as a 电话 alias', () => {
      const result = buildCustomerLabelList(
        baseParams({ supplementDefinitions: [def('联系方式')] }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('13800000000');
    });

    it('resolves 简历 from uploadResume', () => {
      const result = buildCustomerLabelList(
        baseParams({
          supplementDefinitions: [def('简历')],
          uploadResume: 'http://example.com/cv.pdf',
        }),
      );

      expectSuccess(result);
      expect(result.customerLabelList[0].value).toBe('http://example.com/cv.pdf');
    });
  });
});
