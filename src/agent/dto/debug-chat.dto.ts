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
}
