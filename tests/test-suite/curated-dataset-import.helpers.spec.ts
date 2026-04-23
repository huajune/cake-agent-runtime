import { getChangedFieldNames } from '@biz/test-suite/services/curated-dataset-import.helpers';

describe('curated-dataset-import.helpers', () => {
  describe('getChangedFieldNames', () => {
    it('treats null and empty string as different values so clear-with-null updates are not skipped', () => {
      const changed = getChangedFieldNames(
        {
          record_id: 'rec-1',
          fields: {
            备注: '',
          },
        },
        {},
        {
          备注: null,
        },
      );

      expect(changed).toEqual(['备注']);
    });

    it('still treats whitespace-only strings as equivalent after trimming', () => {
      const changed = getChangedFieldNames(
        {
          record_id: 'rec-1',
          fields: {
            标题: '  示例标题  ',
          },
        },
        {},
        {
          标题: '示例标题',
        },
      );

      expect(changed).toEqual([]);
    });
  });
});
