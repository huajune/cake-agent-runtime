/**
 * 收资表单单测的共享夹具。
 *
 * 身份一律假身份（蓝图 §11）：兮兮 / 18271421690。
 * labelId 字面量（769/770/687/771/13…）**只准出现在测试与文档**（D4），
 * 取值照 `docs/todo/label-baseline-20260818.json.gz` 的生产实测基线，
 * 让夹具与真实契约同构、不至于测出一套生产没有的形状。
 */

import type { ContractFieldDef } from '@resolution/collection/form.types';

export const TEST_CANDIDATE_NAME = '兮兮';
export const TEST_CANDIDATE_PHONE = '18271421690';

/** 基线实测：姓名(769,TEXT) / 手机号(770,TEXT) / 年龄(687,TEXT) / 性别(771,SINGLE_OPTION)。 */
export const NAME_FIELD: ContractFieldDef = {
  labelId: 769,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};

export const PHONE_FIELD: ContractFieldDef = {
  labelId: 770,
  labelTitle: '手机号',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'phone',
};

export const AGE_FIELD: ContractFieldDef = {
  labelId: 687,
  labelTitle: '年龄',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'age',
};

/** 基线实测性别 rejected 成对出现：accepted[男] / rejected[女]（34 岗）。 */
export const GENDER_MALE_ONLY_FIELD: ContractFieldDef = {
  labelId: 771,
  labelTitle: '性别',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [{ optionCode: '1', optionLabel: '男' }],
  rejectedOptions: [{ optionCode: '2', optionLabel: '女' }],
  systemField: 'gender',
};

/** 基线实测健康证(13)：三态选项，rejectedOptions 空（不接受办理拒 5 岗是另一批配置）。 */
export const HEALTH_CERT_FIELD: ContractFieldDef = {
  labelId: 13,
  labelTitle: '有无本地健康证',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [
    { optionCode: '1', optionLabel: '有本地有效健康证' },
    { optionCode: '2', optionLabel: '无本地有效健康证，接受办理' },
  ],
  rejectedOptions: [{ optionCode: '3', optionLabel: '无本地有效健康证，不接受办理' }],
};

/** 年龄带契约值域（0820 实测：valueSpec.min/max + unit）。 */
export const AGE_FIELD_18_40: ContractFieldDef = {
  ...AGE_FIELD,
  valueSpec: { kind: 'number', min: 18, max: 40, unit: '岁', genderRanges: [] },
};

/** 分性别值域（实测 528995 身高/体重形态）：顶层 min/max 为 null，区间全在 genderRanges。 */
export const HEIGHT_FIELD_GENDERED: ContractFieldDef = {
  labelId: 4,
  labelTitle: '身高(cm)',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  valueSpec: {
    kind: 'number',
    min: null,
    max: null,
    unit: 'cm',
    genderRanges: [
      { gender: 'MALE', min: 160, max: 190 },
      { gender: 'FEMALE', min: 150, max: 180 },
    ],
  },
};

/** 体重(kg)：与身高同形态的分性别值域（生产 labelId=50 标题「体重(kg)」）。 */
export const WEIGHT_FIELD_GENDERED: ContractFieldDef = {
  labelId: 50,
  labelTitle: '体重(kg)',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  valueSpec: {
    kind: 'number',
    min: null,
    max: null,
    unit: 'kg',
    genderRanges: [
      { gender: 'MALE', min: 50, max: 95 },
      { gender: 'FEMALE', min: 40, max: 75 },
    ],
  },
};

/**
 * 基线实测社保缴纳情况(12)：5 个系统措辞选项（jobId 528762，2026-08-27 生产实拉）。
 * 选项 >4 → 模板普通档不渲染提示；候选人自然答案（「无」）逐字配不上任何标签——
 * badcase batch_6a8fec04ce406a6aee03d65f_* 的字段形态。
 */
export const SOCIAL_INSURANCE_FIELD: ContractFieldDef = {
  labelId: 12,
  labelTitle: '社保缴纳情况',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [
    { optionCode: '1', optionLabel: '本人缴纳本地社保' },
    { optionCode: '2', optionLabel: '无公司在缴社保流水' },
  ],
  rejectedOptions: [
    { optionCode: '3', optionLabel: '公司缴纳本地社保' },
    { optionCode: '4', optionLabel: '本人缴纳外地社保' },
    { optionCode: '5', optionLabel: '公司缴纳外地社保' },
  ],
};

/** 契约标 RESTRICTED 的敏感字段（实测籍贯[3]）。 */
export const HOMETOWN_RESTRICTED_FIELD: ContractFieldDef = {
  labelId: 3,
  labelTitle: '籍贯',
  fieldType: 'SINGLE_OPTION',
  required: true,
  disclosure: 'RESTRICTED',
  acceptedOptions: [{ optionCode: '310000', optionLabel: '上海市' }],
  rejectedOptions: [{ optionCode: '120000', optionLabel: '天津市' }],
};

export function userMessage(text: string): { role: 'user'; content: string } {
  return { role: 'user', content: text };
}

export function assistantMessage(text: string): { role: 'assistant'; content: string } {
  return { role: 'assistant', content: text };
}
