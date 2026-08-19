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
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};

export const PHONE_FIELD: ContractFieldDef = {
  labelId: 770,
  labelTitle: '手机号',
  fieldType: 'TEXT',
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'phone',
};

export const AGE_FIELD: ContractFieldDef = {
  labelId: 687,
  labelTitle: '年龄',
  fieldType: 'TEXT',
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'age',
};

/** 基线实测性别 rejected 成对出现：accepted[男] / rejected[女]（34 岗）。 */
export const GENDER_MALE_ONLY_FIELD: ContractFieldDef = {
  labelId: 771,
  labelTitle: '性别',
  fieldType: 'SINGLE_OPTION',
  acceptedOptions: [{ optionCode: '1', optionLabel: '男' }],
  rejectedOptions: [{ optionCode: '2', optionLabel: '女' }],
  systemField: 'gender',
};

/** 基线实测健康证(13)：三态选项，rejectedOptions 空（不接受办理拒 5 岗是另一批配置）。 */
export const HEALTH_CERT_FIELD: ContractFieldDef = {
  labelId: 13,
  labelTitle: '有无本地健康证',
  fieldType: 'SINGLE_OPTION',
  acceptedOptions: [
    { optionCode: '1', optionLabel: '有本地有效健康证' },
    { optionCode: '2', optionLabel: '无本地有效健康证，接受办理' },
  ],
  rejectedOptions: [{ optionCode: '3', optionLabel: '无本地有效健康证，不接受办理' }],
};

/** 年龄带契约值域（0818 约定 minAge/maxAge 进契约）。 */
export const AGE_FIELD_18_40: ContractFieldDef = { ...AGE_FIELD, minAge: 18, maxAge: 40 };

export function userMessage(text: string): { role: 'user'; content: string } {
  return { role: 'user', content: text };
}

export function assistantMessage(text: string): { role: 'assistant'; content: string } {
  return { role: 'assistant', content: text };
}
