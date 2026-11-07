import { BadRequestException } from '@nestjs/common';
import { validateArticleBlocks } from './magazine-article-blocks.validation';
import { MAGAZINE_ERROR_CODE } from './magazine-error-codes';

/** What `run` throws, or `undefined`, so a spec can assert its body `code`. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const VALID_MIXED_BLOCKS = [
  {
    id: 'b1',
    kind: 'paragraph',
    html: 'The form asked for an emergency contact.',
    lead: true,
  },
  {
    id: 'b2',
    kind: 'heading',
    html: 'The group chat, twenty years on',
  },
  {
    id: 'b3',
    kind: 'pullQuote',
    html: 'Nobody drafted a contract.',
  },
  {
    id: 'b4',
    kind: 'quote',
    html: 'Everyone knew who to call.',
    cite: 'Teresa',
  },
  {
    id: 'b5',
    kind: 'image',
    alt: 'A crowd cheering.',
    caption: 'The 2003 meeting.',
    credit: 'Sara Pinheiro',
    rights: 'courtesy',
    tint: 'coral',
    crop: '16:9',
    focal: { x: 0.5, y: 0.5 },
  },
  {
    id: 'b6',
    kind: 'qa',
    q: 'What do you owe old friends?',
    html: 'A number in your hands.',
    who: 'Sara Pinheiro',
  },
  {
    id: 'b7',
    kind: 'stats',
    items: [{ value: '20', label: 'years' }],
  },
];

describe('validateArticleBlocks', () => {
  it('returns the array unchanged for a valid mixed 7-kind block set', () => {
    expect(validateArticleBlocks(VALID_MIXED_BLOCKS)).toBe(VALID_MIXED_BLOCKS);
  });

  it('throws when input is not an array', () => {
    expect(thrownBy(() => validateArticleBlocks({}))).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCKS_INVALID },
    });
  });

  it('throws when an image block src is neither an upload key nor https', () => {
    // `blocks` is a bare `unknown` on the DTO, so class-validator never reaches
    // this field — an unchecked `src` was the one image reference in the app
    // that could carry a `javascript:` URI into a reader's browser.
    expect(
      thrownBy(() =>
        validateArticleBlocks([
          {
            id: 'b1',
            kind: 'image',
            alt: 'A crowd cheering.',
            caption: '',
            credit: 'Sara Pinheiro',
            rights: 'courtesy',
            tint: 'coral',
            crop: '16:9',
            focal: { x: 0.5, y: 0.5 },
            src: 'javascript:alert(1)',
          },
        ]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: {
        code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCK_IMAGE_SOURCE_INVALID,
      },
    });
  });

  it('accepts an empty image src (a freshly inserted image block)', () => {
    const blocks = [
      {
        id: 'b1',
        kind: 'image',
        alt: 'A crowd cheering.',
        caption: '',
        credit: 'Sara Pinheiro',
        rights: 'courtesy',
        tint: 'coral',
        crop: '16:9',
        focal: { x: 0.5, y: 0.5 },
        src: '',
      },
    ];
    expect(validateArticleBlocks(blocks)).toBe(blocks);
  });

  it('throws when a paragraph html exceeds the size cap', () => {
    expect(
      thrownBy(() =>
        validateArticleBlocks([
          { id: 'b1', kind: 'paragraph', html: 'x'.repeat(20_001) },
        ]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCK_TOO_LONG },
    });
  });

  it('throws when the block count exceeds the per-article cap', () => {
    const blocks = Array.from({ length: 401 }, (unused, index) => ({
      id: `b${index}`,
      kind: 'paragraph',
      html: 'A line.',
    }));
    expect(thrownBy(() => validateArticleBlocks(blocks))).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCKS_TOO_MANY },
    });
  });

  it('throws for an unknown kind', () => {
    expect(
      thrownBy(() => validateArticleBlocks([{ id: 'b1', kind: 'carousel' }])),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCKS_INVALID },
    });
  });

  it('throws when an image block is missing alt', () => {
    expect(
      thrownBy(() =>
        validateArticleBlocks([
          {
            id: 'b1',
            kind: 'image',
            caption: '',
            credit: 'Sara Pinheiro',
            rights: 'courtesy',
            tint: 'coral',
            crop: '16:9',
            focal: { x: 0.5, y: 0.5 },
          },
        ]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: {
        code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCK_FIELD_REQUIRED,
      },
    });
  });

  it('throws when an image block is missing caption', () => {
    expect(
      thrownBy(() =>
        validateArticleBlocks([
          {
            id: 'b1',
            kind: 'image',
            alt: 'A crowd cheering.',
            credit: 'Sara Pinheiro',
            rights: 'courtesy',
            tint: 'coral',
            crop: '16:9',
            focal: { x: 0.5, y: 0.5 },
          },
        ]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCKS_INVALID },
    });
  });

  it('throws when a stats block has non-array items', () => {
    expect(
      thrownBy(() =>
        validateArticleBlocks([
          { id: 'b1', kind: 'stats', items: { value: '20', label: 'years' } },
        ]),
      ),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_ARTICLE_BLOCKS_INVALID },
    });
  });
});
