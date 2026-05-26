import { BOT_TO_RECEIVER, FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';

describe('Feishu receiver mappings', () => {
  it('routes HeMin bot notifications to Zhu Dongsheng', () => {
    expect(BOT_TO_RECEIVER['1688857592548257']).toBe(FEISHU_RECEIVER_USERS.ZHU_DONGSHENG);
  });
});
