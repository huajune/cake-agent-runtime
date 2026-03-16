export class MessagePayload {
  text: string;
}

export class Message {
  payload: MessagePayload;
  type: number;
}

export class Member {
  botUserId: string;
  wxids: string[];
}

export class CreateBroadcastDto {
  token: string;
  messages: Message[];
  members: Member[];
  hasMore: boolean;
  type: number;
}
