import {
  missingCardFields,
  templateAuditName,
  withCopySuffix,
} from './quizshow-template-reads';
import type { QuizshowTemplateCardText } from './quizshow.contract';

const TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-000000000001';

function card(
  overrides: {
    titleEn?: string;
    titlePt?: string;
    descriptionEn?: string;
    descriptionPt?: string;
  } = {},
): QuizshowTemplateCardText {
  return {
    title: {
      en: overrides.titleEn ?? 'Pride and queer history',
      pt: overrides.titlePt ?? 'Orgulho e história queer',
    },
    description: {
      en: overrides.descriptionEn ?? 'From Stonewall to today',
      pt: overrides.descriptionPt ?? 'De Stonewall até hoje',
    },
  };
}

describe('quizshow template reads', () => {
  it('names the missing card fields for the languages the quiz uses', () => {
    expect(missingCardFields(card(), 'both')).toEqual([]);
    expect(
      missingCardFields(
        card({
          titleEn: '',
          titlePt: ' ',
          descriptionEn: '',
          descriptionPt: '\t',
        }),
        'both',
      ),
    ).toEqual(['title.en', 'title.pt', 'description.en', 'description.pt']);
    expect(
      missingCardFields(card({ titlePt: '', descriptionEn: '  ' }), 'both'),
    ).toEqual(['title.pt', 'description.en']);
    expect(
      missingCardFields(card({ titlePt: '', descriptionEn: '  ' }), 'en'),
    ).toEqual(['description.en']);
    expect(
      missingCardFields(card({ titlePt: '', descriptionEn: '  ' }), 'pt'),
    ).toEqual(['title.pt']);
  });

  it('keeps a duplicated title within 120 characters', () => {
    const longTitle = withCopySuffix({ en: 'x'.repeat(120), pt: '' });
    expect(longTitle.en).toHaveLength(120);
    expect(longTitle.en.endsWith(' (copy)')).toBe(true);
    expect(longTitle.pt).toBe('');

    const longPortugueseTitle = withCopySuffix({
      en: '',
      pt: 'y'.repeat(120),
    });
    expect(longPortugueseTitle.pt).toHaveLength(120);
    expect(longPortugueseTitle.pt.endsWith(' (cópia)')).toBe(true);
    expect(longPortugueseTitle.en).toBe('');

    expect(
      withCopySuffix({
        en: 'Pride and queer history',
        pt: 'Orgulho e história queer',
      }),
    ).toEqual({
      en: 'Pride and queer history (copy)',
      pt: 'Orgulho e história queer (cópia)',
    });

    const cutAtSpace = withCopySuffix({
      en: `${'a'.repeat(112)} bbbbbbb`,
      pt: '   ',
    });
    expect(cutAtSpace.en).toBe(`${'a'.repeat(112)} (copy)`);
    expect(cutAtSpace.pt).toBe('');
  });

  it('names the template in the audit row by EN, then PT, then id', () => {
    expect(templateAuditName(card(), TEMPLATE_ID)).toBe(
      'Pride and queer history',
    );
    expect(templateAuditName(card({ titleEn: '  ' }), TEMPLATE_ID)).toBe(
      'Orgulho e história queer',
    );
    expect(
      templateAuditName(card({ titleEn: '', titlePt: '' }), TEMPLATE_ID),
    ).toBe(TEMPLATE_ID);
  });
});
