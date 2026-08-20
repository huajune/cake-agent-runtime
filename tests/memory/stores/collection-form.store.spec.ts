import {
  buildCollectionFormKey,
  buildCollectionFormLocatorKey,
  CollectionFormStore,
} from '@memory/stores/collection-form.store';
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
const SCOPE = { corpId: 'corp1', userId: 'user1', jobId: 528962 };
const TTL = 172800;

describe('CollectionFormStore', () => {
  const redisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(true),
  };
  let store: CollectionFormStore;

  beforeEach(() => {
    jest.clearAllMocks();
    redisStore.get.mockResolvedValue(null);
    store = new CollectionFormStore(redisStore as never, { sessionTtl: TTL } as never);
  });

  it('按实体 key 读取对象快照，缺失或非对象内容 fail-closed 返回 null', async () => {
    const form = createForm({ jobId: SCOPE.jobId, contract: [FIELD] });
    redisStore.get.mockResolvedValueOnce({ content: form });
    await expect(store.read({ ...SCOPE, candidateRef: 'session' })).resolves.toBe(form);
    expect(redisStore.get).toHaveBeenLastCalledWith(
      buildCollectionFormKey({
        ...SCOPE,
        candidateRef: 'session',
      }),
    );

    redisStore.get.mockResolvedValueOnce({ content: 'corrupted' });
    await expect(store.read({ ...SCOPE, candidateRef: 'session' })).resolves.toBeNull();
  });

  it('当前人键指针只接受非空字符串', async () => {
    redisStore.get.mockResolvedValueOnce({ content: { candidateRef: '18271421690' } });
    await expect(store.readCurrentCandidateRef(SCOPE)).resolves.toBe('18271421690');
    expect(redisStore.get).toHaveBeenCalledWith(buildCollectionFormLocatorKey(SCOPE));

    redisStore.get.mockResolvedValueOnce({ content: { candidateRef: '' } });
    await expect(store.readCurrentCandidateRef(SCOPE)).resolves.toBeNull();
  });

  it('整实体与当前人键指针均按 session TTL 覆盖写，禁用 deepMerge', async () => {
    const form = createForm({
      candidateRef: '18271421690',
      jobId: SCOPE.jobId,
      contract: [FIELD],
    });
    await store.write(SCOPE, form);

    expect(redisStore.set).toHaveBeenNthCalledWith(
      1,
      buildCollectionFormKey({ ...SCOPE, candidateRef: form.candidateRef }),
      form,
      TTL,
      false,
    );
    expect(redisStore.set).toHaveBeenNthCalledWith(
      2,
      buildCollectionFormLocatorKey(SCOPE),
      { candidateRef: form.candidateRef },
      TTL,
      false,
    );
  });

  it('删除当前实体时同步删除 locator', async () => {
    redisStore.get.mockResolvedValueOnce({ content: { candidateRef: 'session' } });
    await store.remove({ ...SCOPE, candidateRef: 'session' });

    expect(redisStore.del).toHaveBeenNthCalledWith(
      1,
      buildCollectionFormKey({ ...SCOPE, candidateRef: 'session' }),
    );
    expect(redisStore.del).toHaveBeenNthCalledWith(2, buildCollectionFormLocatorKey(SCOPE));
  });

  it('删除非当前实体时保留 locator，避免抹掉已 rebind 的人键指针', async () => {
    redisStore.get.mockResolvedValueOnce({ content: { candidateRef: '18271421690' } });
    await store.remove({ ...SCOPE, candidateRef: 'session' });

    expect(redisStore.del).toHaveBeenCalledTimes(1);
    expect(redisStore.del).not.toHaveBeenCalledWith(buildCollectionFormLocatorKey(SCOPE));
  });
});
