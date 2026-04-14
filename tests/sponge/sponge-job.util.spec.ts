import { extractInterviewSupplementDefinitions } from '@sponge/sponge-job.util';
import { JobDetail } from '@sponge/sponge.types';

describe('sponge-job.util', () => {
  describe('extractInterviewSupplementDefinitions', () => {
    it('should return empty array when job or interview supplements are missing', () => {
      expect(extractInterviewSupplementDefinitions(undefined)).toEqual([]);
      expect(extractInterviewSupplementDefinitions(null)).toEqual([]);
      expect(extractInterviewSupplementDefinitions({})).toEqual([]);
      expect(
        extractInterviewSupplementDefinitions({
          interviewProcess: {
            interviewSupplement: null,
          },
        }),
      ).toEqual([]);
    });

    it('should support both lowercase and uppercase upstream field names', () => {
      const job: JobDetail = {
        interviewProcess: {
          interviewSupplement: [
            {
              interviewSupplementId: 4,
              interviewSupplement: '身高',
            },
            {
              InterviewSupplementId: 13,
              InterviewSupplement: '有无健康证',
            },
          ],
        },
      };

      expect(extractInterviewSupplementDefinitions(job)).toEqual([
        {
          labelId: 4,
          labelName: '身高',
          name: '身高',
        },
        {
          labelId: 13,
          labelName: '有无健康证',
          name: '有无健康证',
        },
      ]);
    });

    it('should ignore malformed items and deduplicate duplicate definitions', () => {
      const job: JobDetail = {
        interviewProcess: {
          interviewSupplement: [
            null,
            'invalid',
            {
              interviewSupplementId: 4,
              interviewSupplement: ' 身高 ',
            },
            {
              InterviewSupplementId: 4,
              InterviewSupplement: '身高',
            },
            {
              interviewSupplementId: 50,
              interviewSupplement: '   ',
            },
            {
              interviewSupplementId: 0,
              interviewSupplement: '体重',
            },
            {
              interviewSupplementId: 324,
              interviewSupplement: '具体家庭住址',
            },
          ],
        },
      };

      expect(extractInterviewSupplementDefinitions(job)).toEqual([
        {
          labelId: 4,
          labelName: '身高',
          name: '身高',
        },
        {
          labelId: 324,
          labelName: '具体家庭住址',
          name: '具体家庭住址',
        },
      ]);
    });
  });
});
