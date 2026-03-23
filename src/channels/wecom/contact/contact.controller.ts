import { Controller, Get, Query } from '@nestjs/common';
import { ContactService } from './contact.service';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /**
   * 获取联系人列表
   * 访问: GET http://localhost:3000/contact/list
   */
  @Get('list')
  async getContactList(
    @Query('token') token: string,
    @Query('current') current?: number,
    @Query('pageSize') pageSize?: number,
    @Query('wxid') wxid?: string,
    @Query('includeStranger') includeStranger?: boolean,
  ) {
    return await this.contactService.getContactList(
      token,
      current,
      pageSize,
      wxid,
      includeStranger,
    );
  }
}
