import { PendingHostingSourceService } from '@wecom/message/application/pending-hosting-source.service';
import type { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { WECOM_API_TYPE } from '@shared-types/wecom-api.types';
import { STRIDE_PRIMARY_CONNECTION } from '@/types/hosting-route';

const message = {
  messageId: 'queued',
  chatId: 'chat',
  imBotId: 'bot',
  timestamp: 1700000000000,
  groupId: 'old-group',
  token: 'fixture',
} as unknown as EnterpriseMessageCallbackDto;

function setup(
  row = { hosting_connection_id: null as string | null, tenant_id: null as string | null },
) {
  const read = {
    match: jest.fn().mockReturnThis(),
    abortSignal: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: row }),
  };
  const write = {
    match: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    abortSignal: jest.fn().mockResolvedValue({ error: null }),
  };
  const table = {
    select: jest.fn().mockReturnValue(read),
    update: jest.fn().mockReturnValue(write),
  };
  const groups = { verifyCallback: jest.fn().mockResolvedValue({ groupId: 'current-group' }) };
  const service = new PendingHostingSourceService(
    { getSupabaseClient: () => ({ from: () => table }) } as never,
    { get: () => 'fixture' } as never,
    groups as never,
  );
  return { service, groups, table, read, write };
}

it('stamps only the matching old user row with authenticated enterprise source', async () => {
  const { service, table, read, write } = setup();
  expect(await service.restore(message)).toBe(true);
  const identity = {
    message_id: 'queued',
    chat_id: 'chat',
    im_bot_id: 'bot',
    timestamp: new Date(Number(message.timestamp)).toISOString(),
    role: 'user',
  };
  expect(read.match).toHaveBeenCalledWith(identity);
  expect(write.match).toHaveBeenCalledWith(identity);
  expect(write.is.mock.calls).toEqual(
    ['hosting_connection_id', 'hosting_group_id', 'hosting_observed_group_id', 'tenant_id'].map(
      (field) => [field, null],
    ),
  );
  expect(table.update).toHaveBeenCalledWith({
    hosting_connection_id: STRIDE_PRIMARY_CONNECTION,
    hosting_group_id: 'old-group',
  });
});
it('records only an observation for a verified group callback', async () => {
  const { service, table, groups } = setup();
  expect(await service.restore({ ...message, _apiType: WECOM_API_TYPE.GROUP })).toBe(true);
  expect(groups.verifyCallback).toHaveBeenCalled();
  expect(table.update).toHaveBeenCalledWith({
    hosting_connection_id: STRIDE_PRIMARY_CONNECTION,
    hosting_observed_group_id: 'current-group',
  });
});
it('requires a valid original credential and never replaces a recorded conflict', async () => {
  const { service, table, groups } = setup();
  expect(await service.restore({ ...message, token: 'invalid' })).toBe(false);
  groups.verifyCallback.mockResolvedValueOnce(null);
  expect(await service.restore({ ...message, _apiType: WECOM_API_TYPE.GROUP })).toBe(false);
  expect(table.update).not.toHaveBeenCalled();
  const conflict = setup({ hosting_connection_id: STRIDE_PRIMARY_CONNECTION, tenant_id: null });
  expect(await conflict.service.restore(message)).toBe(false);
  expect(conflict.table.update).not.toHaveBeenCalled();
});
it('propagates storage failure so the queue can retry', async () => {
  const { service, write } = setup();
  write.abortSignal.mockResolvedValueOnce({ error: { code: 'unavailable' } });
  await expect(service.restore(message)).rejects.toThrow('暂时无法登记');
});
