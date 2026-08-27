import {
  identitySlotKeyForTitle,
  mapContractFields,
  parseIdentityAnchors,
  resolveIdentityKey,
} from '@resolution/collection/contract-mapping';
import type { ContractField, JobCollectionContract } from '@sponge/collection-contract.types';

/** 0820 生产实测形状（jobId 528962 姓名槽）。labelId 字面量只许出现在测试与文档（D4）。 */
function field(overrides: Partial<ContractField> & Pick<ContractField, 'labelId' | 'labelTitle'>) {
  return {
    labelInstructions: null,
    fieldType: 'TEXT' as const,
    disclosure: 'PLAIN' as const,
    required: true,
    valueSpec: null,
    acceptedOptions: [],
    rejectedOptions: [],
    ...overrides,
  };
}

describe('parseIdentityAnchors', () => {
  it('解析环境级锚点配置；脏条目跳过不炸整轮', () => {
    const config = parseIdentityAnchors('name:769, phone:770 , age:abc, bogus:1, ,gender:771');
    expect(config.anchors.get(769)).toBe('name');
    expect(config.anchors.get(770)).toBe('phone');
    expect(config.anchors.get(771)).toBe('gender');
    expect(config.anchors.size).toBe(3);
  });

  it('没配就是空表——代码里不留任何 labelId 默认值（D4）', () => {
    expect(parseIdentityAnchors(undefined).anchors.size).toBe(0);
    expect(parseIdentityAnchors('').anchors.size).toBe(0);
  });
});

describe('identitySlotKeyForTitle', () => {
  it('身份同义词全匹配命中四槽键；包含式不误触发（供收资标题第三级回退复用，词条唯一居所）', () => {
    expect(identitySlotKeyForTitle('联系方式')).toBe('phone');
    expect(identitySlotKeyForTitle('联系电话')).toBe('phone');
    expect(identitySlotKeyForTitle('真实姓名')).toBe('name');
    expect(identitySlotKeyForTitle('周岁')).toBe('age');
    expect(identitySlotKeyForTitle('电话费报销')).toBeNull();
    expect(identitySlotKeyForTitle('紧急联系人电话')).toBeNull();
  });
});

describe('resolveIdentityKey', () => {
  const anchors = parseIdentityAnchors('name:769,phone:770,age:687,gender:771');

  it('按标题语义识别身份四槽（契约不带语义标记，0826 裁定 systemField 诉求废弃）', () => {
    expect(
      resolveIdentityKey(field({ labelId: 769, labelTitle: '姓名' }), anchors).systemField,
    ).toBe('name');
    expect(
      resolveIdentityKey(field({ labelId: 770, labelTitle: '手机号' }), anchors).systemField,
    ).toBe('phone');
  });

  it('无锚点配置时纯标题也能识别——锚点只是加速，不是必需', () => {
    const empty = parseIdentityAnchors('');
    expect(
      resolveIdentityKey(field({ labelId: 12345, labelTitle: '年龄' }), empty).systemField,
    ).toBe('age');
  });

  it('锚点与标题对不上 → 不认身份、报 mismatch（标签表重建的静默断链）', () => {
    const resolved = resolveIdentityKey(
      field({ labelId: 769, labelTitle: '紧急联系人姓名' }),
      anchors,
    );
    expect(resolved.systemField).toBeUndefined();
    expect(resolved.anchorMismatch).toEqual({
      labelId: 769,
      expected: 'name',
      labelTitle: '紧急联系人姓名',
    });
  });

  it('非身份标签既不认也不报错', () => {
    const resolved = resolveIdentityKey(field({ labelId: 756, labelTitle: '具体住址' }), anchors);
    expect(resolved.systemField).toBeUndefined();
    expect(resolved.anchorMismatch).toBeUndefined();
  });
});

describe('mapContractFields', () => {
  const contract: JobCollectionContract = {
    jobId: 528995,
    fields: [
      field({ labelId: 769, labelTitle: '姓名' }),
      field({
        labelId: 4,
        labelTitle: '身高(cm)',
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
      }),
      field({
        labelId: 3,
        labelTitle: '籍贯',
        fieldType: 'SINGLE_OPTION',
        disclosure: 'RESTRICTED',
        acceptedOptions: [{ optionCode: '310000', optionLabel: '上海市' }],
        rejectedOptions: [{ optionCode: '120000', optionLabel: '天津市' }],
      }),
    ],
  };

  it('映射保真：披露级别/必填/值域/选项集逐项过桥', () => {
    const { fields } = mapContractFields(contract, parseIdentityAnchors(''));
    expect(fields).toHaveLength(3);

    const [name, height, hometown] = fields;
    expect(name.systemField).toBe('name');
    expect(name.required).toBe(true);

    expect(height.valueSpec?.genderRanges).toEqual([
      { gender: 'MALE', min: 160, max: 190 },
      { gender: 'FEMALE', min: 150, max: 180 },
    ]);
    expect(height.valueSpec?.unit).toBe('cm');

    expect(hometown.disclosure).toBe('RESTRICTED');
    expect(hometown.rejectedOptions).toEqual([{ optionCode: '120000', optionLabel: '天津市' }]);
  });

  it('锚点核验不过的槽位降为通用道，并汇总供调用方告警', () => {
    const { fields, anchorMismatches } = mapContractFields(
      { jobId: 1, fields: [field({ labelId: 769, labelTitle: '紧急联系人' })] },
      parseIdentityAnchors('name:769'),
    );
    expect(fields[0].systemField).toBeUndefined();
    expect(anchorMismatches).toHaveLength(1);
    expect(anchorMismatches[0].labelId).toBe(769);
  });
});
