import { Body, Controller, Logger, Post } from '@nestjs/common';
import { Public, RawResponse } from '@infra/server/response/decorators/api-response.decorator';
import { NewCustomerCallbackService } from './new-customer-callback.service';

/**
 * 「新增客户回调—RPA」入口：POST /new-customer
 *
 * 平台侧配置回调地址为 https://cake.duliday.com/new-customer。
 * - @Public：第三方回调，跳过 ApiTokenGuard。
 * - @RawResponse：不套统一响应壳，按平台预期返回。
 * - 同步 ACK + 异步处理（见 service），避免超时触发平台重试封禁。
 */
@Public()
@Controller('new-customer')
export class NewCustomerCallbackController {
  private readonly logger = new Logger(NewCustomerCallbackController.name);

  constructor(private readonly service: NewCustomerCallbackService) {}

  @RawResponse()
  @Post()
  receiveNewCustomer(@Body() body: unknown) {
    // 不打 name/avatar 等 PII，仅打关键 id 便于排障。
    const raw = (body ?? {}) as Record<string, unknown>;
    const payload = (raw.data ?? raw) as Record<string, unknown>;
    this.logger.log(
      `=== [新增客户回调-RPA] imContactId=${payload?.imContactId ?? '-'}, createTimestamp=${payload?.createTimestamp ?? '-'}`,
    );
    return this.service.handleNewCustomer(body);
  }
}
