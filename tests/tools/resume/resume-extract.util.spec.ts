import type { LlmExecutorService } from '@/llm/llm-executor.service';
import { notarizeResumeFields } from '@resolution/candidate/resume-fields';
import {
  extractResumeFieldsViaModel,
  RESUME_EXTRACT_SCHEMA,
} from '@tools/resume/resume-extract.util';

describe('resume-extract.util', () => {
  it('uses Extract structured output and marks every result as model testimony', async () => {
    const generateStructured = jest.fn().mockResolvedValue({
      output: {
        fields: [
          { field: 'name', value: '兮兮', sourceText: '姓名：兮兮' },
          { field: 'phone', value: '18271421690', sourceText: '电话：18271421690' },
        ],
      },
    });
    const llm = { generateStructured } as unknown as LlmExecutorService;
    await expect(
      extractResumeFieldsViaModel('姓名：兮兮\n电话：18271421690', llm),
    ).resolves.toEqual([
      { field: 'name', value: '兮兮', sourceText: '姓名：兮兮', extractedBy: 'extract_model' },
      {
        field: 'phone',
        value: '18271421690',
        sourceText: '电话：18271421690',
        extractedBy: 'extract_model',
      },
    ]);
    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'extract',
        schema: RESUME_EXTRACT_SCHEMA,
        maxOutputTokens: 800,
      }),
    );
  });

  it('lets notary reject a model-invented field as quote_not_found', async () => {
    const text = '姓名：兮兮\n电话：18271421690';
    const llm = {
      generateStructured: jest.fn().mockResolvedValue({
        output: {
          fields: [{ field: 'education', value: '本科', sourceText: '最高学历：本科' }],
        },
      }),
    } as unknown as LlmExecutorService;
    const fields = await extractResumeFieldsViaModel(text, llm);
    const result = notarizeResumeFields(fields, text);

    expect(result.education).toBeUndefined();
    expect(result.notaryDrops).toContainEqual({
      field: 'education',
      reason: 'quote_not_found',
    });
  });

  it('propagates provider failures so the tool can switch to fallback rules', async () => {
    const llm = {
      generateStructured: jest.fn().mockRejectedValue(new Error('extract unavailable')),
    } as unknown as LlmExecutorService;
    await expect(extractResumeFieldsViaModel('姓名：兮兮', llm)).rejects.toThrow(
      'extract unavailable',
    );
  });
});
