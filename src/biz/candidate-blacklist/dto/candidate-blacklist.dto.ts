import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AddCandidateBlacklistDto {
  /** 候选人标识：chatId / imContactId / externalUserId 任一均可 */
  @IsString()
  targetId: string;

  /** 拉黑理由（命中告警与暂停记录中展示，必填且不可为空字符串） */
  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsOptional()
  @IsString()
  operator?: string;

  /** 拉黑时的会话快照（可选，供回溯） */
  @IsOptional()
  @IsString()
  chatId?: string;

  @IsOptional()
  @IsString()
  imContactId?: string;

  @IsOptional()
  @IsString()
  contactName?: string;
}

export class RemoveCandidateBlacklistDto {
  @IsString()
  targetId: string;
}
