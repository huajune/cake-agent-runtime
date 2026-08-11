/** 按原始顺序抽出的对话轮次，供确认问答类判据消费。 */
export interface DialogueTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 候选人通过位置消息分享的经纬度。 */
export interface LocationShareCoordinates {
  latitude: number;
  longitude: number;
}
