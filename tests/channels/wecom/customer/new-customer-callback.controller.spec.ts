import { NewCustomerCallbackController } from '@wecom/customer/new-customer-callback.controller';
import { NewCustomerCallbackService } from '@wecom/customer/new-customer-callback.service';

describe('NewCustomerCallbackController', () => {
  let handleNewCustomer: jest.Mock;
  let controller: NewCustomerCallbackController;

  beforeEach(() => {
    // 控制器很薄：仅打关键 id 日志 + 同步 ACK 委托给 service.handleNewCustomer。
    handleNewCustomer = jest.fn().mockReturnValue({ success: true });
    controller = new NewCustomerCallbackController({
      handleNewCustomer,
    } as unknown as NewCustomerCallbackService);
  });

  it('扁平报文 → 原样委托 service.handleNewCustomer 并回传其结果', () => {
    const body = { imContactId: 'c-1', createTimestamp: 1705580628000, name: 'x' };

    const result = controller.receiveNewCustomer(body);

    expect(handleNewCustomer).toHaveBeenCalledTimes(1);
    expect(handleNewCustomer).toHaveBeenCalledWith(body);
    expect(result).toEqual({ success: true });
  });

  it('data 包裹报文 / 空报文不抛错（日志取 payload.data ?? raw）', () => {
    expect(() => controller.receiveNewCustomer({ data: { imContactId: 'c-2' } })).not.toThrow();
    expect(() => controller.receiveNewCustomer(undefined)).not.toThrow();
    expect(handleNewCustomer).toHaveBeenCalledTimes(2);
  });
});
