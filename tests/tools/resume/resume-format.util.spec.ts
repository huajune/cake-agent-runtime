import { detectResumeFormat, imageMediaType } from '@tools/resume/resume-format.util';

describe('resume-format.util', () => {
  it.each([
    [Buffer.from('%PDF-1.7'), 'pdf'],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), 'docx'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xdb]), 'image'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image'],
    [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'legacy_doc'],
    [Buffer.from('plain text'), 'unknown'],
  ] as const)('detects magic bytes as %s', (buffer, expected) => {
    expect(detectResumeFormat(buffer)).toBe(expected);
  });

  it('reports supported image media types only', () => {
    expect(imageMediaType(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(imageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(imageMediaType(Buffer.from('GIF89a'))).toBeNull();
  });
});
