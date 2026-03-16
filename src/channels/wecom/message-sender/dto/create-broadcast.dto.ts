import {
  IsString,
  IsNotEmpty,
  IsArray,
  IsBoolean,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 消息内容
 */
export class MessagePayload {
  @IsString()
  @IsNotEmpty()
  text: string;
}

/**
 * 消息对象
 */
export class Message {
  @ValidateNested()
  @Type(() => MessagePayload)
  payload: MessagePayload;

  @IsNumber()
  type: number;
}

/**
 * 群发成员
 */
export class Member {
  @IsString()
  @IsNotEmpty()
  botUserId: string;

  @IsArray()
  @IsString({ each: true })
  wxids: string[];
}

/**
 * 创建群发消息 DTO
 */
export class CreateBroadcastDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Message)
  messages: Message[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Member)
  members: Member[];

  @IsBoolean()
  hasMore: boolean;

  @IsNumber()
  type: number;
}
