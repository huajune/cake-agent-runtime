import { CollectionFormService } from '@tools/collection/collection-form.service';
import { buildCollectionFormKey } from '@tools/collection/collection-form.store';
import { createForm, proposeValue, type ContractFieldDef } from '@resolution/collection';

const NAME_FIELD: ContractFieldDef = {
  labelId: 769,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};
const ADDRESS_FIELD: ContractFieldDef = {
  labelId: 756,
  labelTitle: '具体住址',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};
const HEALTH_CERT_FIELD: ContractFieldDef = {
  labelId: 802,
  labelTitle: '健康证情况',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};

const SCOPE = { corpId: 'corp1', userId: 'user1', botUserId: 'wecom-user-A', jobId: 528962 };
const TEST_PHONE = '18271421690';

describe('CollectionFormService', () => {
  const store = {
    read: jest.fn(),
    readCurrentCandidateRef: jest.fn(),
    write: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const sessionState = {
    saveCollectionProgressFact: jest.fn().mockResolvedValue(undefined),
  };
  let service: CollectionFormService;

  beforeEach(() => {
    jest.clearAllMocks();
    store.read.mockResolvedValue(null);
    store.readCurrentCandidateRef.mockResolvedValue(null);
    sessionState.saveCollectionProgressFact.mockResolvedValue(undefined);
    service = new CollectionFormService(store as never, sessionState as never);
  });

  it('key 形态包含稳定 botUserId 维度且保留前缀', () => {
    expect(
      buildCollectionFormKey({
        corpId: 'c',
        userId: 'u',
        botUserId: 'bot-a',
        candidateRef: TEST_PHONE,
        jobId: 1,
      }),
    ).toBe(`collection-form:c:u:bot-a:${TEST_PHONE}:1`);
  });

  it('本轮落定的交集格逐格写 medium；岗位自定义格不回流', async () => {
    const contract = [NAME_FIELD, HEALTH_CERT_FIELD, ADDRESS_FIELD];
    const form = createForm({ jobId: SCOPE.jobId, contract });
    for (const [field, value] of [
      [NAME_FIELD, '兮兮'],
      [HEALTH_CERT_FIELD, '有'],
      [ADDRESS_FIELD, '人民路 1 号'],
    ] as const) {
      form.slots[field.labelId] = {
        labelId: field.labelId,
        state: 'filled',
        askCount: 0,
        value: {
          value,
          sourceText: value,
          producer: 'candidate_quote',
          confidence: 'high',
        },
      };
    }

    await service.saveFinalizedProgressFacts(
      { ...SCOPE, sessionId: 'session-1' },
      form,
      contract,
      contract,
      '2026-08-25T10:00:00.000Z',
    );

    expect(sessionState.saveCollectionProgressFact).toHaveBeenNthCalledWith(
      1,
      'corp1',
      'user1',
      'session-1',
      'name',
      expect.objectContaining({
        value: '兮兮',
        confidence: 'medium',
        source: 'candidate_quote',
        evidence: '收资表单第 1 格落定（姓名，labelId=769）',
        extractedAt: '2026-08-25T10:00:00.000Z',
      }),
    );
    expect(sessionState.saveCollectionProgressFact).toHaveBeenNthCalledWith(
      2,
      'corp1',
      'user1',
      'session-1',
      'has_health_certificate',
      expect.objectContaining({ value: '有', confidence: 'medium' }),
    );
    expect(sessionState.saveCollectionProgressFact).toHaveBeenCalledTimes(2);
  });

  describe('loadOrCreate', () => {
    it('无存量 → 按契约开空表，人键未知挂 session', async () => {
      const form = await service.loadOrCreate(SCOPE, [NAME_FIELD]);
      expect(form.candidateRef).toBe('session');
      expect(Object.keys(form.slots)).toEqual(['769']);
    });

    it('手机号已知优先读人键表', async () => {
      const stored = createForm({
        candidateRef: TEST_PHONE,
        jobId: 528962,
        contract: [NAME_FIELD],
      });
      store.read.mockImplementation(async ({ candidateRef }: { candidateRef: string }) =>
        candidateRef === TEST_PHONE ? stored : null,
      );
      const form = await service.loadOrCreate(SCOPE, [NAME_FIELD], TEST_PHONE);
      expect(form.candidateRef).toBe(TEST_PHONE);
    });

    it('人键表还没有就回落 session 表——先聊后给号不丢进度', async () => {
      const stored = createForm({ jobId: 528962, contract: [NAME_FIELD] });
      store.read.mockImplementation(async ({ candidateRef }: { candidateRef: string }) =>
        candidateRef === 'session' ? stored : null,
      );
      const form = await service.loadOrCreate(SCOPE, [NAME_FIELD], TEST_PHONE);
      expect(form.candidateRef).toBe('session');
    });

    it('契约新增槽位补入；已有槽位一格不动（含候选人原话）', async () => {
      const text = '姓名：兮兮';
      const filled = proposeValue(
        createForm({ jobId: 528962, contract: [NAME_FIELD] }),
        NAME_FIELD,
        {
          value: '兮兮',
          sourceText: text,
          producer: 'candidate_quote',
          candidateTexts: [text],
          messages: [{ role: 'user', content: text }],
        },
      ).form;
      store.read.mockResolvedValue(filled);

      const form = await service.loadOrCreate(SCOPE, [NAME_FIELD, ADDRESS_FIELD]);
      expect(form.slots[756].state).toBe('empty');
      expect(form.slots[769].state).toBe('filled');
      expect(form.slots[769].value?.value).toBe('兮兮');
    });

    it('契约里消失的槽位退出办理态，不再卡 verdict 或误进 payload', async () => {
      const stored = createForm({ jobId: 528962, contract: [NAME_FIELD, ADDRESS_FIELD] });
      store.read.mockResolvedValue(stored);
      const form = await service.loadOrCreate(SCOPE, [NAME_FIELD]);
      expect(form.slots[756]).toBeUndefined();
    });

    it('存量表单随实时契约补齐或清理 systemField 语义标记', async () => {
      const stored = createForm({ jobId: 528962, contract: [ADDRESS_FIELD] });
      store.read.mockResolvedValue(stored);

      const marked = await service.loadOrCreate(SCOPE, [
        { ...ADDRESS_FIELD, systemField: 'gender' },
      ]);
      expect(marked.slots[756].systemField).toBe('gender');

      store.read.mockResolvedValue(marked);
      const cleared = await service.loadOrCreate(SCOPE, [ADDRESS_FIELD]);
      expect(cleared.slots[756].systemField).toBeUndefined();
    });

    it('调用方不再传手机号时，经当前指针读回 rebind 后的人键表', async () => {
      const stored = createForm({
        candidateRef: TEST_PHONE,
        jobId: 528962,
        contract: [NAME_FIELD],
      });
      store.readCurrentCandidateRef.mockResolvedValue(TEST_PHONE);
      store.read.mockImplementation(async ({ candidateRef }: { candidateRef: string }) =>
        candidateRef === TEST_PHONE ? stored : null,
      );

      const form = await service.loadOrCreate(SCOPE, [NAME_FIELD]);
      expect(form.candidateRef).toBe(TEST_PHONE);
    });
  });

  describe('rebindToPhone', () => {
    it('搬家而非重开：写新 key 后删旧 key，槽位原样带走', async () => {
      const form = createForm({ jobId: 528962, contract: [NAME_FIELD] });
      const rebound = await service.rebindToPhone(SCOPE, form, TEST_PHONE);

      expect(rebound.candidateRef).toBe(TEST_PHONE);
      expect(rebound.slots).toEqual(form.slots);
      expect(store.write).toHaveBeenCalledWith(
        SCOPE,
        expect.objectContaining({ candidateRef: TEST_PHONE }),
      );
      expect(store.remove).toHaveBeenCalledWith(
        expect.objectContaining({ candidateRef: 'session' }),
      );
    });

    it('非法号码不作人键，表单不动（占位号/短号不许当人键）', async () => {
      const form = createForm({ jobId: 528962, contract: [NAME_FIELD] });
      for (const bogus of ['', '123', 'abc']) {
        const result = await service.rebindToPhone(SCOPE, form, bogus);
        expect(result.candidateRef).toBe('session');
      }
      expect(store.remove).not.toHaveBeenCalled();
    });

    it('人键已是该号 → 幂等，不重复搬家', async () => {
      const form = createForm({ candidateRef: TEST_PHONE, jobId: 528962, contract: [NAME_FIELD] });
      await service.rebindToPhone(SCOPE, form, TEST_PHONE);
      expect(store.remove).not.toHaveBeenCalled();
    });
  });
});
