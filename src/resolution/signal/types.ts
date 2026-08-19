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

/** 视觉字段的事实所有者；跨生产者与消费端共享，归信号轴而非视觉实现所有。 */
export const FIELD_OWNERSHIPS = ['candidate', 'publisher', 'third_party', 'unknown'] as const;
export type FieldOwnership = (typeof FIELD_OWNERSHIPS)[number];
