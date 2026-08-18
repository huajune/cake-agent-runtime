import {
  ACTION_MIN_CONFIDENCE,
  canUseFactForAction,
} from '@tools/shared/action-confidence';

describe('action confidence permissions', () => {
  it('covers every confidence-gated action in one explicit table', () => {
    expect(Object.keys(ACTION_MIN_CONFIDENCE).sort()).toEqual([
      'invite_city',
      'store_location_geocode',
    ]);
  });

  it('requires high confidence for invite city facts', () => {
    expect(ACTION_MIN_CONFIDENCE.invite_city).toBe('high');
    expect(canUseFactForAction('invite_city', 'high')).toBe(true);
    expect(canUseFactForAction('invite_city', 'medium')).toBe(false);
  });

  it('requires high confidence for store-location geocode candidates', () => {
    expect(ACTION_MIN_CONFIDENCE.store_location_geocode).toBe('high');
    expect(canUseFactForAction('store_location_geocode', 'high')).toBe(true);
    expect(canUseFactForAction('store_location_geocode', 'low')).toBe(false);
  });
});
