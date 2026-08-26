import {
  buildCollectionFormKey,
  buildCollectionFormLocatorKey,
  COLLECTION_FORM_TTL_SECONDS,
  CollectionFormStore,
} from '@tools/collection/collection-form.store';
import { createForm, type ContractFieldDef } from '@resolution/collection';

const FIELD: ContractFieldDef = {
  labelId: 769,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};
const SCOPE = { corpId: 'corp1', userId: 'user1', botUserId: 'wecom-user-A', jobId: 528962 };
describe('CollectionFormStore', () => {
  const redis = {
    get: jest.fn(),
    setex: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
  };
  let store: CollectionFormStore;

  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    store = new CollectionFormStore(redis as never);
  });

  it('按实体 key 读取对象快照，缺失或非对象内容 fail-closed 返回 null', async () => {
    const form = createForm({ jobId: SCOPE.jobId, contract: [FIELD] });
    redis.get.mockResolvedValueOnce({ content: form });
    await expect(store.read({ ...SCOPE, candidateRef: 'session' })).resolves.toBe(form);
    expect(redis.get).toHaveBeenLastCalledWith(
      buildCollectionFormKey({
        ...SCOPE,
        candidateRef: 'session',
      }),
    );

    redis.get.mockResolvedValueOnce({ content: 'corrupted' });
    await expect(store.read({ ...SCOPE, candidateRef: 'session' })).resolves.toBeNull();
  });

  it('当前人键指针只接受非空字符串', async () => {
    redis.get.mockResolvedValueOnce({ content: { candidateRef: '18271421690' } });
    await expect(store.readCurrentCandidateRef(SCOPE)).resolves.toBe('18271421690');
    expect(redis.get).toHaveBeenCalledWith(buildCollectionFormLocatorKey(SCOPE));

    redis.get.mockResolvedValueOnce({ content: { candidateRef: '' } });
    await expect(store.readCurrentCandidateRef(SCOPE)).resolves.toBeNull();
  });

  it('整实体与当前人键指针均按收资域 3 天 TTL 覆盖写', async () => {
    const form = createForm({
      candidateRef: '18271421690',
      jobId: SCOPE.jobId,
      contract: [FIELD],
    });
    await store.write(SCOPE, form);

    expect(redis.setex).toHaveBeenNthCalledWith(
      1,
      buildCollectionFormKey({ ...SCOPE, candidateRef: form.candidateRef }),
      COLLECTION_FORM_TTL_SECONDS,
      expect.objectContaining({ content: form }),
    );
    expect(redis.setex).toHaveBeenNthCalledWith(
      2,
      buildCollectionFormLocatorKey(SCOPE),
      COLLECTION_FORM_TTL_SECONDS,
      expect.objectContaining({ content: { candidateRef: form.candidateRef } }),
    );
  });

  it('同一候选人与岗位在不同 bot 下各自读写独立表单与 locator', async () => {
    const shared = {
      corpId: SCOPE.corpId,
      userId: SCOPE.userId,
      candidateRef: '18271421690',
      jobId: SCOPE.jobId,
    };
    const snapshots = new Map<string, unknown>();
    redis.setex.mockImplementation(async (key: string, _ttl: number, entry: unknown) => {
      snapshots.set(key, entry);
    });
    redis.get.mockImplementation(async (key: string) => snapshots.get(key) ?? null);

    const formA = createForm({ ...shared, contract: [FIELD] });
    formA.slots[FIELD.labelId] = {
      labelId: FIELD.labelId,
      state: 'filled',
      askCount: 0,
      value: {
        value: 'bot A 的答案',
        sourceText: 'bot A 的答案',
        producer: 'candidate_quote',
        confidence: 'high',
      },
    };
    const formB = createForm({ ...shared, contract: [FIELD] });
    await store.write({ ...shared, botUserId: 'wecom-user-A' }, formA);
    await store.write({ ...shared, botUserId: 'wecom-user-B' }, formB);

    expect(buildCollectionFormKey({ ...shared, botUserId: 'wecom-user-A' })).not.toBe(
      buildCollectionFormKey({ ...shared, botUserId: 'wecom-user-B' }),
    );
    expect(
      buildCollectionFormLocatorKey({ ...SCOPE, botUserId: 'wecom-user-A' }),
    ).not.toBe(buildCollectionFormLocatorKey({ ...SCOPE, botUserId: 'wecom-user-B' }));
    await expect(
      store.read({ ...shared, botUserId: 'wecom-user-A' }),
    ).resolves.toEqual(formA);
    await expect(
      store.read({ ...shared, botUserId: 'wecom-user-B' }),
    ).resolves.toEqual(formB);
    await expect(
      store.readCurrentCandidateRef({ ...SCOPE, botUserId: 'wecom-user-A' }),
    ).resolves.toBe(shared.candidateRef);
    await expect(
      store.readCurrentCandidateRef({ ...SCOPE, botUserId: 'wecom-user-B' }),
    ).resolves.toBe(shared.candidateRef);
  });

  it('删除当前实体时同步删除 locator', async () => {
    redis.get.mockResolvedValueOnce({ content: { candidateRef: 'session' } });
    await store.remove({ ...SCOPE, candidateRef: 'session' });

    expect(redis.del).toHaveBeenNthCalledWith(
      1,
      buildCollectionFormKey({ ...SCOPE, candidateRef: 'session' }),
    );
    expect(redis.del).toHaveBeenNthCalledWith(2, buildCollectionFormLocatorKey(SCOPE));
  });

  it('删除非当前实体时保留 locator，避免抹掉已 rebind 的人键指针', async () => {
    redis.get.mockResolvedValueOnce({ content: { candidateRef: '18271421690' } });
    await store.remove({ ...SCOPE, candidateRef: 'session' });

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalledWith(buildCollectionFormLocatorKey(SCOPE));
  });
});
