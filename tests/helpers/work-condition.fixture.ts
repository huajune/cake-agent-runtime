import type { ContractFieldDef } from '@resolution/collection';

/** audit 459023 / batch_6aea9566ce406a6aee2ccfb0_1793759532338；不含候选人身份资料。 */
export const DURATION_FIELD: ContractFieldDef = {
  labelId: 797,
  labelTitle: '要求做到年后',
  fieldType: 'SINGLE_OPTION',
  disclosure: 'PLAIN',
  required: true,
  acceptedOptions: [
    { optionCode: '50222', optionLabel: '可以做到年后' },
    { optionCode: '50223', optionLabel: '可以做6个月以上' },
  ],
  rejectedOptions: [
    { optionCode: '50224', optionLabel: '只能做0-3个月' },
    { optionCode: '50225', optionLabel: '可以做3-6个月' },
  ],
};

export const AVAILABILITY_FIELD: ContractFieldDef = {
  labelId: 741,
  labelTitle: '每天可工作时间段',
  fieldType: 'MULTIPLE_OPTION',
  disclosure: 'PLAIN',
  required: true,
  acceptedOptions: [
    { optionCode: 'day', optionLabel: '07:00-16:00' },
    { optionCode: 'evening', optionLabel: '16:00-23:00' },
  ],
  rejectedOptions: [],
};

export const WEEKEND_FIELD: ContractFieldDef = {
  labelId: 798,
  labelTitle: '周末两天是否在岗',
  fieldType: 'SINGLE_OPTION',
  disclosure: 'PLAIN',
  required: true,
  acceptedOptions: [{ optionCode: 'both', optionLabel: '周末两天都在接受门店排班' }],
  rejectedOptions: [{ optionCode: 'saturday', optionLabel: '只能周六在' }],
};
