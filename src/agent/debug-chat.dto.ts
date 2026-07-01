import { IsOptional, IsString } from 'class-validator';

export class DebugChatDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  scenario?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  /** 企微显示名称/备注（用于调试「备注品牌门店优先」线索注入） */
  @IsOptional()
  @IsString()
  contactName?: string;
}
