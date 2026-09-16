import {
  MAX_DOWNLOAD_FILE_NAME_LENGTH,
  OPAQUE_DOWNLOAD_CONTENT_TYPE,
  asciiFallbackFileName,
  attachmentContentDisposition,
  buildDocumentDownloadHeaders,
  documentServedContentType,
  encodeRfc5987Value,
  sanitizeDownloadFileName,
} from './document-download-headers';
import { contentDispositionForStorageKey } from './served-object';

const USER_SEGMENT = '11111111-2222-3333-4444-555555555555';
const FILE_SEGMENT = '66666666-7777-8888-9999-000000000000';

const documentKey = (extension: string) =>
  `message-documents/${USER_SEGMENT}/${FILE_SEGMENT}${extension}`;

// Built from code points so the spec source never contains the raw characters.
const NUL = String.fromCharCode(0x00);
const NEXT_LINE = String.fromCharCode(0x85);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800);
const E_ACUTE = String.fromCharCode(0xe9);

describe('sanitizeDownloadFileName', () => {
  it('keeps an ordinary name that already ends in the minted extension', () => {
    expect(sanitizeDownloadFileName('lease.pdf', documentKey('.pdf'))).toBe(
      'lease.pdf',
    );
  });

  it('treats the extension case-insensitively and normalises it to the key', () => {
    expect(sanitizeDownloadFileName('Lease.PDF', documentKey('.pdf'))).toBe(
      'Lease.pdf',
    );
  });

  it('appends the minted extension when the name claims another type', () => {
    expect(sanitizeDownloadFileName('invoice.exe', documentKey('.pdf'))).toBe(
      'invoice.exe.pdf',
    );
  });

  it('removes CR and LF so the name can never inject a header', () => {
    const sanitized = sanitizeDownloadFileName(
      'a\r\nSet-Cookie: x=1.pdf',
      documentKey('.pdf'),
    );
    expect(sanitized).not.toMatch(/[\r\n]/);
    expect(sanitized).toBe('aSet-Cookie: x=1.pdf');
  });

  it('removes NUL and C1 control characters', () => {
    expect(
      sanitizeDownloadFileName(
        `re${NUL}po${NEXT_LINE}rt.csv`,
        documentKey('.csv'),
      ),
    ).toBe('report.csv');
  });

  it('replaces quotes, backslashes and slashes', () => {
    expect(
      sanitizeDownloadFileName('../"evil"\\name.txt', documentKey('.txt')),
    ).toBe('__evil__name.txt');
  });

  it('strips leading dots so a download is never a hidden file', () => {
    expect(sanitizeDownloadFileName('...env.csv', documentKey('.csv'))).toBe(
      'env.csv',
    );
  });

  it('removes bidirectional overrides that disguise the real extension', () => {
    expect(
      sanitizeDownloadFileName(
        `invoice${RIGHT_TO_LEFT_OVERRIDE}fdp.exe`,
        documentKey('.pdf'),
      ),
    ).toBe('invoicefdp.exe.pdf');
  });

  it('drops lone surrogates so encoding never throws', () => {
    const sanitized = sanitizeDownloadFileName(
      `broken${LONE_HIGH_SURROGATE}name.pdf`,
      documentKey('.pdf'),
    );
    expect(sanitized).toBe('brokenname.pdf');
    expect(() => encodeRfc5987Value(sanitized)).not.toThrow();
  });

  it('caps the length and still ends in the minted extension', () => {
    const sanitized = sanitizeDownloadFileName(
      `${'a'.repeat(500)}.pdf`,
      documentKey('.pdf'),
    );
    expect(Array.from(sanitized)).toHaveLength(MAX_DOWNLOAD_FILE_NAME_LENGTH);
    expect(sanitized.endsWith('.pdf')).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['only whitespace and control characters', ` ${NUL}\r\n `],
    ['only dots', '...'],
  ])('falls back to the server-minted name for %s', (_label, value) => {
    expect(sanitizeDownloadFileName(value, documentKey('.pdf'))).toBe(
      `${FILE_SEGMENT}.pdf`,
    );
  });
});

describe('asciiFallbackFileName', () => {
  it('replaces non-ASCII characters and percent signs', () => {
    expect(asciiFallbackFileName(`contrato ${E_ACUTE} 100%.pdf`)).toBe(
      'contrato _ 100_.pdf',
    );
  });
});

describe('encodeRfc5987Value', () => {
  it('percent-encodes UTF-8 and the characters encodeURIComponent leaves bare', () => {
    expect(encodeRfc5987Value(`${E_ACUTE} (1)'*.pdf`)).toBe(
      '%C3%A9%20%281%29%27%2A.pdf',
    );
  });
});

describe('attachmentContentDisposition', () => {
  it('emits an attachment with both the ASCII and the UTF-8 filename', () => {
    expect(attachmentContentDisposition(`r${E_ACUTE}sum${E_ACUTE}.pdf`)).toBe(
      `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    );
  });
});

describe('documentServedContentType', () => {
  it.each([
    ['.pdf', 'application/pdf'],
    [
      '.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['.txt', OPAQUE_DOWNLOAD_CONTENT_TYPE],
    ['.csv', OPAQUE_DOWNLOAD_CONTENT_TYPE],
  ])('serves %s as %s', (extension, expected) => {
    expect(documentServedContentType(documentKey(extension))).toBe(expected);
  });

  it('serves an unknown extension as opaque bytes', () => {
    expect(documentServedContentType('message-documents/u/f.bin')).toBe(
      OPAQUE_DOWNLOAD_CONTENT_TYPE,
    );
  });
});

describe('buildDocumentDownloadHeaders', () => {
  it('returns the full hardened header set for a PDF', () => {
    expect(
      buildDocumentDownloadHeaders({
        storageKey: documentKey('.pdf'),
        originalFileName: 'lease.pdf',
      }),
    ).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="lease.pdf"; filename*=UTF-8''lease.pdf`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store',
    });
  });

  it('never serves plain text with a renderable content type', () => {
    const headers = buildDocumentDownloadHeaders({
      storageKey: documentKey('.txt'),
      originalFileName: 'notes.txt',
    });
    expect(headers['Content-Type']).toBe(OPAQUE_DOWNLOAD_CONTENT_TYPE);
  });

  it('uses the server-minted name when no display name was found', () => {
    const headers = buildDocumentDownloadHeaders({
      storageKey: documentKey('.csv'),
      originalFileName: null,
    });
    expect(headers['Content-Disposition']).toBe(
      `attachment; filename="${FILE_SEGMENT}.csv"; filename*=UTF-8''${FILE_SEGMENT}.csv`,
    );
  });
});

// The presigned-GET disposition (`StorageService.createPresignedDownload`),
// covered here so the document half of PRD-369 is tested in one place.
describe('contentDispositionForStorageKey', () => {
  it('signs a message document as an attachment', () => {
    expect(contentDispositionForStorageKey(documentKey('.pdf'))).toBe(
      `attachment; filename="${FILE_SEGMENT}.pdf"`,
    );
  });

  it('keeps an image inline', () => {
    expect(
      contentDispositionForStorageKey(
        `avatars/${USER_SEGMENT}/${FILE_SEGMENT}.jpg`,
      ),
    ).toBe(`inline; filename="${FILE_SEGMENT}.jpg"`);
  });
});
