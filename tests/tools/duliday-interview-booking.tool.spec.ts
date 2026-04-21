import {
  buildCustomerLabelList,
  type BuildCustomerLabelListParams,
  type BuildCustomerLabelListResult,
} from '@tools/duliday-interview-booking.tool';
import type { SpongeInterviewSupplementDefinition } from '@sponge/sponge-job.util';
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
