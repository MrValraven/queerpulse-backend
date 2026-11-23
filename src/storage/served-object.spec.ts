import {
  AUDIO_MAGIC_BYTE_PREFIX_LENGTH,
  contentTypeForStorageKey,
  inlineContentDispositionForStorageKey,
  isQuickTimeBrand,
  jpegCarriesGpsLocation,
  magicBytesMatchContentType,
} from './served-object';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const GIF89 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
// HTML masquerading as an image ("<!DOCTYPE" -> 3C 21 44 4F ...).
const HTML = Uint8Array.from([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54]);
// PDF header: "%PDF-".
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
// XLSX (OOXML) is a ZIP: local-file-header signature.
const XLSX_ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('contentTypeForStorageKey', () => {
  it.each([
    ['avatars/u/f.jpg', 'image/jpeg'],
    ['work/u/f.png', 'image/png'],
    ['story-covers/u/f.webp', 'image/webp'],
    ['message-images/u/f.gif', 'image/gif'],
    ['message-documents/u/f.pdf', 'application/pdf'],
    ['message-documents/u/f.txt', 'text/plain'],
    ['message-documents/u/f.csv', 'text/csv'],
    ['message-documents/u/f.xlsx', XLSX_CONTENT_TYPE],
  ])('maps %s -> %s', (key, expected) => {
    expect(contentTypeForStorageKey(key)).toBe(expected);
  });

  it('returns null for an unknown extension or no extension', () => {
    expect(contentTypeForStorageKey('avatars/u/f.svg')).toBeNull();
    expect(contentTypeForStorageKey('avatars/u/f')).toBeNull();
  });
});

describe('inlineContentDispositionForStorageKey', () => {
  it('uses only the final (server-minted) path segment as the filename', () => {
    expect(inlineContentDispositionForStorageKey('avatars/u/abc.jpg')).toBe(
      'inline; filename="abc.jpg"',
    );
  });
});

describe('magicBytesMatchContentType', () => {
  it('accepts bytes that match their declared type', () => {
    expect(magicBytesMatchContentType(JPEG, 'image/jpeg')).toBe(true);
    expect(magicBytesMatchContentType(PNG, 'image/png')).toBe(true);
    expect(magicBytesMatchContentType(GIF89, 'image/gif')).toBe(true);
    expect(magicBytesMatchContentType(WEBP, 'image/webp')).toBe(true);
  });

  it('rejects bytes whose signature contradicts the declared type', () => {
    expect(magicBytesMatchContentType(HTML, 'image/png')).toBe(false);
    expect(magicBytesMatchContentType(PNG, 'image/jpeg')).toBe(false);
    // A truncated RIFF header without the WEBP fourCC is not a webp.
    expect(
      magicBytesMatchContentType(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
        'image/webp',
      ),
    ).toBe(false);
  });

  it('rejects a null content type outright', () => {
    expect(magicBytesMatchContentType(JPEG, null)).toBe(false);
  });

  it('accepts a PDF header and rejects a mismatched one', () => {
    expect(magicBytesMatchContentType(PDF, 'application/pdf')).toBe(true);
    expect(magicBytesMatchContentType(HTML, 'application/pdf')).toBe(false);
  });

  it('accepts an XLSX (ZIP local-file-header) signature', () => {
    expect(magicBytesMatchContentType(XLSX_ZIP, XLSX_CONTENT_TYPE)).toBe(true);
    expect(magicBytesMatchContentType(PDF, XLSX_CONTENT_TYPE)).toBe(false);
  });

  it('accepts plain text/CSV bytes and rejects a NUL-containing binary payload', () => {
    const TEXT = new TextEncoder().encode('name,email\nAna,ana@example.com');
    expect(magicBytesMatchContentType(TEXT, 'text/plain')).toBe(true);
    expect(magicBytesMatchContentType(TEXT, 'text/csv')).toBe(true);
    const BINARY_WITH_NUL = Uint8Array.from([0x41, 0x00, 0x42, 0x00]);
    expect(magicBytesMatchContentType(BINARY_WITH_NUL, 'text/plain')).toBe(
      false,
    );
  });
});

// VJ: MP4 is an ISO base media file (`ftyp` box), WebM an EBML file.
describe('VJ video signatures', () => {
  // size 0x20, `ftyp`, major brand `isom`.
  const MP4_ISOM = Uint8Array.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
  ]);
  // The same box with major brand `qt  `: a QuickTime MOV.
  const MOV_QUICKTIME = Uint8Array.from([
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const WEBM_EBML = Uint8Array.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
  ]);

  it('matches MP4 and WebM signatures and refuses a QuickTime brand', () => {
    expect(magicBytesMatchContentType(MP4_ISOM, 'video/mp4')).toBe(true);
    expect(magicBytesMatchContentType(MOV_QUICKTIME, 'video/mp4')).toBe(false);
    expect(isQuickTimeBrand(MOV_QUICKTIME)).toBe(true);
    expect(isQuickTimeBrand(MP4_ISOM)).toBe(false);
    expect(magicBytesMatchContentType(WEBM_EBML, 'video/webm')).toBe(true);
    expect(magicBytesMatchContentType(MP4_ISOM, 'video/webm')).toBe(false);
    expect(magicBytesMatchContentType(WEBM_EBML, 'video/mp4')).toBe(false);
    expect(magicBytesMatchContentType(GIF89, 'video/mp4')).toBe(false);
    expect(magicBytesMatchContentType(GIF89, 'video/webm')).toBe(false);
  });

  it('serves .mp4 and .webm keys as video', () => {
    const FIRST_UUID = '0b6f2a4c-1d2e-4f30-9a8b-7c6d5e4f3a2b';
    const SECOND_UUID = '5d1e7c90-2a3b-4c4d-8e5f-6a7b8c9d0e1f';
    expect(
      contentTypeForStorageKey(`vj-clips/${FIRST_UUID}/${SECOND_UUID}.mp4`),
    ).toBe('video/mp4');
    expect(
      contentTypeForStorageKey(`vj-clips/${FIRST_UUID}/${SECOND_UUID}.webm`),
    ).toBe('video/webm');
    expect(
      contentTypeForStorageKey(`vj-clips/${FIRST_UUID}/${SECOND_UUID}.gif`),
    ).toBe('image/gif');
  });

  it('serves .webm and .mp4 preview keys as video', () => {
    const FIRST_UUID = '0b6f2a4c-1d2e-4f30-9a8b-7c6d5e4f3a2b';
    const SECOND_UUID = '5d1e7c90-2a3b-4c4d-8e5f-6a7b8c9d0e1f';
    expect(
      contentTypeForStorageKey(`vj-previews/${FIRST_UUID}/${SECOND_UUID}.webm`),
    ).toBe('video/webm');
    expect(
      contentTypeForStorageKey(`vj-previews/${FIRST_UUID}/${SECOND_UUID}.mp4`),
    ).toBe('video/mp4');
    expect(
      inlineContentDispositionForStorageKey(
        `vj-previews/${FIRST_UUID}/${SECOND_UUID}.webm`,
      ),
    ).toBe(`inline; filename="${SECOND_UUID}.webm"`);
  });
});

// Open item A: Studio audio is an MP3 (an ID3v2 tag at byte 0, or a Layer III
// frame header within the bytes read) or an M4A (any `ftyp` box but QuickTime).
// The attach parse stays authoritative, so this check refuses only what can
// be no audio of that kind.
describe('Studio audio signatures', () => {
  // `ID3`, version 2.4.0, zeroed flags, then the tag size.
  const MP3_ID3 = Uint8Array.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x23,
  ]);
  // MPEG-1 Layer III at 128 kbit/s and 44.1 kHz, without a CRC.
  const MP3_FRAME_HEADER = [0xff, 0xfb, 0x90, 0x64];
  const MP3_FRAME = Uint8Array.from([...MP3_FRAME_HEADER, 0x00, 0x00]);
  // MPEG-2 Layer III, as a low-bitrate voice memo is written.
  const MP3_MPEG2_FRAME = Uint8Array.from([0xff, 0xf3, 0x48, 0xc4]);
  // 40 zero bytes of padding ahead of the first frame, inside the 64 read.
  const MP3_PADDED = Uint8Array.from([
    ...new Array<number>(40).fill(0),
    ...MP3_FRAME_HEADER,
    ...new Array<number>(20).fill(0),
  ]);
  // ADTS AAC shares the sync bits and carries layer `00`.
  const ADTS_AAC = Uint8Array.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f]);
  // A frame header with the invalid bitrate index `1111`.
  const MP3_BAD_BITRATE = Uint8Array.from([0xff, 0xfb, 0xf0, 0x64]);
  // `ID3` with a major version no ID3v2 tag carries.
  const ID3_BAD_VERSION = Uint8Array.from([0x49, 0x44, 0x33, 0xff, 0x00]);
  const ftypWithBrand = (brand: string): Uint8Array =>
    Uint8Array.from([
      0x00,
      0x00,
      0x00,
      0x20,
      0x66,
      0x74,
      0x79,
      0x70,
      ...Array.from(brand, (letter) => letter.charCodeAt(0)),
      0x00,
      0x00,
      0x02,
      0x00,
    ]);

  it('matches an MP3 by its ID3v2 tag or its Layer III frame header', () => {
    expect(magicBytesMatchContentType(MP3_ID3, 'audio/mpeg')).toBe(true);
    expect(magicBytesMatchContentType(MP3_FRAME, 'audio/mpeg')).toBe(true);
    expect(magicBytesMatchContentType(MP3_MPEG2_FRAME, 'audio/mpeg')).toBe(
      true,
    );
  });

  it('finds the first frame header of an MP3 behind leading padding', () => {
    expect(MP3_PADDED.length).toBe(AUDIO_MAGIC_BYTE_PREFIX_LENGTH);
    expect(magicBytesMatchContentType(MP3_PADDED, 'audio/mpeg')).toBe(true);
  });

  it('refuses ADTS AAC, a bad frame header, a bad ID3 version and other files as MP3', () => {
    for (const bytes of [
      ADTS_AAC,
      MP3_BAD_BITRATE,
      ID3_BAD_VERSION,
      HTML,
      JPEG,
      ftypWithBrand('M4A '),
      Uint8Array.from(new Array<number>(64).fill(0)),
    ]) {
      expect(magicBytesMatchContentType(bytes, 'audio/mpeg')).toBe(false);
    }
  });

  it.each(['M4A ', 'mp42', 'isom', '3gp4', 'dash', 'iso5'])(
    'matches an M4A whose major brand is %s',
    (brand) => {
      expect(
        magicBytesMatchContentType(ftypWithBrand(brand), 'audio/mp4'),
      ).toBe(true);
    },
  );

  it('refuses a QuickTime brand and other files as M4A', () => {
    for (const bytes of [ftypWithBrand('qt  '), MP3_ID3, WEBP, HTML]) {
      expect(magicBytesMatchContentType(bytes, 'audio/mp4')).toBe(false);
    }
  });

  it('knows no audio/x-m4a type: Studio audio is stored as audio/mp4 only', () => {
    expect(
      magicBytesMatchContentType(ftypWithBrand('M4A '), 'audio/x-m4a'),
    ).toBe(false);
  });
});

// SEC-43: a JPEG whose EXIF IFD0 holds the GPS pointer tag (0x8825).
describe('jpegCarriesGpsLocation', () => {
  // An APP1 EXIF segment whose IFD0 holds one entry with `tag`, in the byte
  // order `byteOrder` names.
  function jpegWithExifTag(tag: number, byteOrder: 'II' | 'MM'): Uint8Array {
    const isLittleEndian = byteOrder === 'II';
    const tiff = new Uint8Array(8 + 2 + 12 + 4);
    const view = new DataView(tiff.buffer);
    tiff[0] = byteOrder.charCodeAt(0);
    tiff[1] = byteOrder.charCodeAt(1);
    view.setUint16(2, 0x2a, isLittleEndian);
    view.setUint32(4, 8, isLittleEndian);
    view.setUint16(8, 1, isLittleEndian);
    view.setUint16(10, tag, isLittleEndian);
    view.setUint16(12, 4, isLittleEndian);
    view.setUint32(14, 1, isLittleEndian);
    view.setUint32(18, 26, isLittleEndian);
    const exifIdentifier = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    const payloadLength = exifIdentifier.length + tiff.length;
    const segmentLength = payloadLength + 2;
    return Uint8Array.from([
      0xff,
      0xd8,
      // An APP0/JFIF segment first, as most encoders write.
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00,
      0xff,
      0xe1,
      segmentLength >> 8,
      segmentLength & 0xff,
      ...exifIdentifier,
      ...tiff,
      0xff,
      0xda,
    ]);
  }

  it('finds the GPS pointer in a little-endian EXIF block', () => {
    expect(jpegCarriesGpsLocation(jpegWithExifTag(0x8825, 'II'))).toBe(true);
  });

  it('finds the GPS pointer in a big-endian EXIF block', () => {
    expect(jpegCarriesGpsLocation(jpegWithExifTag(0x8825, 'MM'))).toBe(true);
  });

  it('passes EXIF that carries no GPS block', () => {
    // 0x0112 is the orientation tag.
    expect(jpegCarriesGpsLocation(jpegWithExifTag(0x0112, 'II'))).toBe(false);
  });

  it('passes a re-encoded JPEG with no EXIF at all', () => {
    expect(jpegCarriesGpsLocation(JPEG)).toBe(false);
  });

  it('is false for bytes that are no JPEG', () => {
    expect(jpegCarriesGpsLocation(PNG)).toBe(false);
  });

  it('survives a segment that runs past the bytes read', () => {
    const truncated = jpegWithExifTag(0x8825, 'II').subarray(0, 20);
    expect(jpegCarriesGpsLocation(truncated)).toBe(false);
  });
});
