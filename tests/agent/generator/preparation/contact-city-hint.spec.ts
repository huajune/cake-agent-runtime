import { resolveContactCityHint } from '@agent/generator/preparation/contact-city-hint';

describe('resolveContactCityHint', () => {
  it('周度 case 10/9：运营把城市追加在联系人备注里 → 给出城市线索', () => {
    expect(resolveContactCityHint('龙虾过敏   佛山', null)).toBe('佛山');
  });

  it('会话已有城市事实时不给线索，避免与已确认城市并列', () => {
    expect(resolveContactCityHint('龙虾过敏   佛山', '上海')).toBeNull();
  });

  it('昵称里没有城市、或城市字样只是村名/路名时不给线索', () => {
    expect(resolveContactCityHint('龙虾过敏', null)).toBeNull();
    expect(resolveContactCityHint('上海村小王', null)).toBeNull();
    expect(resolveContactCityHint(undefined, null)).toBeNull();
  });
});
