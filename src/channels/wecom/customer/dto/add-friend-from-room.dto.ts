export class AddFriendFromRoomDto {
  token: string;
  roomId: string;
  contactId: string;
  remark?: string;
  helloMsg?: string;
  extraInfo?: string;
  userId: string;
}
