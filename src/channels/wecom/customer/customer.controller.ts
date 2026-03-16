import { Controller, Get, Query } from '@nestjs/common';
import { CustomerService } from './customer.service';

/**
 * 客户管理控制器
 * 专注于客户关系管理（CRM）功能
 */
@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /**
   * 获取客户列表 v2
   * @description 查询客户列表，支持多种过滤条件
   * @example GET /customer/v2/list?token=xxx&current=0&pageSize=20
   */
  @Get('v2/list')
  async getCustomerListV2(
    @Query('token') token: string,
    @Query('wecomUserId') wecomUserId?: string,
    @Query('imBotId') imBotId?: string,
    @Query('coworker') coworker?: boolean,
    @Query('current') current?: number,
    @Query('pageSize') pageSize?: number,
  ) {
    return await this.customerService.getCustomerListV2(
      token,
      wecomUserId,
      imBotId,
      coworker,
      current,
      pageSize,
    );
  }
}
