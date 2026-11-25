import {
  TEMPLATE_CARDS_SQL,
  TEMPLATE_DETAIL_SQL,
  TEMPLATE_PREVIEW_SQL,
  TEMPLATE_ROWS_SQL,
  missingCardFields,
  nameOf,
  templateAuditName,
  toTemplateCard,
  toTemplateDetail,
  toTemplatePreview,
  withCopySuffix,
  type TemplateDetailRow,
} from './quizshow-template-reads';
import type {
  QuizshowQuiz,
  QuizshowTemplateCardText,
} from './quizshow.contract';

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

const CONTENT_UPDATED_AT = new Date('2026-11-20T10:00:00.000Z');
const PUBLISHED_AT = new Date('2026-11-01T10:00:00.000Z');

function detailRow(
  overrides: Partial<TemplateDetailRow> = {},
): TemplateDetailRow {
  return {
    id: TEMPLATE_ID,
    card_title_en: 'Pride and queer history',
    card_title_pt: 'Orgulho e história queer',
    card_description_en: 'From Stonewall to today',
    card_description_pt: 'De Stonewall até hoje',
    staff_notes: 'Checked against the archive',
    published_at: PUBLISHED_AT,
    content_updated_at: CONTENT_UPDATED_AT,
    change_note_en: 'Round 2 rewritten',
    change_note_pt: 'Ronda 2 reescrita',
    quiz_id: 'quiz-1',
    first_name: 'Rui',
    last_name: 'Matos',
    ...overrides,
  };
}

/** A quiz whose rows carry options, answers, notes and media, so the preview test can prove none of it leaks. */
function quizWithSecrets(): QuizshowQuiz {
  return {
    title: 'Pride night',
    languages: 'both',
    screenLanguage: 'en',
    sourceTemplateId: null,
    sourceTemplate: null,
    updatedAt: '2026-11-20T09:00:00.000Z',
    rounds: [
      {
        id: 'round-0',
        kind: 'quiz',
        title: { en: 'History', pt: 'História' },
        contentLabel: 'none',
        settings: {} as QuizshowQuiz['rounds'][number]['settings'],
        questions: [
          {
            id: 'question-0',
            type: 'multiple_choice',
            prompt: { en: 'Which year?', pt: 'Que ano?' },
            mediaRef: 'event-covers/owner/secret-photo.jpg',
            mediaUrl: 'https://cdn.example/secret-photo.jpg',
            mediaAlt: { en: 'A crowd', pt: 'Uma multidão' },
            mediaReveal: 'instant',
            revealNote: { en: 'Secret fun fact', pt: 'Curiosidade secreta' },
            numberUnit: { en: '', pt: '' },
            timeLimitSeconds: null,
            points: 1000,
            options: [
              { id: 'a', text: { en: 'Secret option', pt: 'Opção secreta' } },
              { id: 'b', text: { en: '1969', pt: '1969' } },
            ],
            answer: { correctIndexes: [1] },
            acceptedAnswers: [],
          },
        ],
      },
      {
        id: 'round-1',
        kind: 'wheel',
        title: { en: 'Spin', pt: 'Roda' },
        contentLabel: 'adults',
        settings: {} as QuizshowQuiz['rounds'][number]['settings'],
        questions: [],
      },
    ],
  };
}

describe('quizshow template reads', () => {
  it.each([
    ['TEMPLATE_ROWS_SQL', TEMPLATE_ROWS_SQL],
    ['TEMPLATE_CARDS_SQL', TEMPLATE_CARDS_SQL],
  ])(
    '%s counts rounds without wheel steps, with a cast that runs before the enum has the label',
    (_name, sql) => {
      const roundCountSubquery = sql.slice(0, sql.indexOf('AS "round_count"'));
      expect(roundCountSubquery).toContain(
        `AND "round"."kind"::text <> 'wheel'`,
      );
      expect(sql.match(/<> 'wheel'/g)).toHaveLength(1);
    },
  );

  it('selects the content stamp and the change note columns', () => {
    expect(TEMPLATE_CARDS_SQL).toContain(
      '"template"."content_updated_at" AS "content_updated_at"',
    );
    expect(TEMPLATE_DETAIL_SQL).toContain(
      '"template"."content_updated_at" AS "content_updated_at"',
    );
    expect(TEMPLATE_DETAIL_SQL).toContain(
      '"template"."change_note_en" AS "change_note_en"',
    );
    expect(TEMPLATE_DETAIL_SQL).toContain(
      '"template"."change_note_pt" AS "change_note_pt"',
    );
    expect(TEMPLATE_PREVIEW_SQL).toContain(
      '"template"."published_at" IS NOT NULL',
    );
    expect(TEMPLATE_PREVIEW_SQL).not.toContain('staff_notes');
    expect(TEMPLATE_PREVIEW_SQL).not.toContain('change_note');
  });

  it('gives a card the content stamp as its last publish, else the publish date', () => {
    const cardRow = {
      id: TEMPLATE_ID,
      card_title_en: 'Pride and queer history',
      card_title_pt: 'Orgulho e história queer',
      card_description_en: 'From Stonewall to today',
      card_description_pt: 'De Stonewall até hoje',
      content_updated_at: CONTENT_UPDATED_AT,
      published_at: PUBLISHED_AT,
      languages: 'both' as const,
      round_count: 3,
      question_count: 12,
      has_adults_rounds: false,
    };
    expect(toTemplateCard(cardRow).lastPublishedAt).toBe(
      CONTENT_UPDATED_AT.toISOString(),
    );
    expect(
      toTemplateCard({ ...cardRow, content_updated_at: null }).lastPublishedAt,
    ).toBe(PUBLISHED_AT.toISOString());
    expect(
      toTemplateCard({
        ...cardRow,
        content_updated_at: '2026-11-21T08:00:00.000Z',
      }).lastPublishedAt,
    ).toBe('2026-11-21T08:00:00.000Z');
  });

  it('maps the change note and the last publish onto the detail, null for a draft', () => {
    const quiz = quizWithSecrets();
    const published = toTemplateDetail(detailRow(), quiz);
    expect(published.changeNote).toEqual({
      en: 'Round 2 rewritten',
      pt: 'Ronda 2 reescrita',
    });
    expect(published.lastPublishedAt).toBe(CONTENT_UPDATED_AT.toISOString());
    expect(published.publishedAt).toBe(PUBLISHED_AT.toISOString());

    const notBackfilled = toTemplateDetail(
      detailRow({ content_updated_at: null }),
      quiz,
    );
    expect(notBackfilled.lastPublishedAt).toBe(PUBLISHED_AT.toISOString());

    const draft = toTemplateDetail(
      detailRow({
        published_at: null,
        change_note_en: null,
        change_note_pt: null,
      }),
      quiz,
    );
    expect(draft.lastPublishedAt).toBeNull();
    expect(draft.changeNote).toEqual({ en: '', pt: '' });
  });

  it('builds a preview with prompts only and no option, answer, note or media key', () => {
    const preview = toTemplatePreview(
      {
        id: TEMPLATE_ID,
        card_title_en: 'Pride and queer history',
        card_title_pt: 'Orgulho e história queer',
        card_description_en: 'From Stonewall to today',
        card_description_pt: 'De Stonewall até hoje',
        quiz_id: 'quiz-1',
      },
      quizWithSecrets(),
    );

    expect(preview).toEqual({
      templateId: TEMPLATE_ID,
      title: { en: 'Pride and queer history', pt: 'Orgulho e história queer' },
      description: {
        en: 'From Stonewall to today',
        pt: 'De Stonewall até hoje',
      },
      languages: 'both',
      rounds: [
        {
          roundIndex: 0,
          kind: 'quiz',
          title: { en: 'History', pt: 'História' },
          questionCount: 1,
          sliceCount: null,
          contentLabel: 'none',
          prompts: [{ en: 'Which year?', pt: 'Que ano?' }],
        },
        {
          roundIndex: 1,
          kind: 'wheel',
          title: { en: 'Spin', pt: 'Roda' },
          questionCount: 0,
          sliceCount: null,
          contentLabel: 'adults',
          prompts: [],
        },
      ],
    });
    const payload = JSON.stringify(preview);
    for (const hiddenKey of [
      '"answer"',
      '"options"',
      '"staffNotes"',
      '"acceptedAnswers"',
      '"revealNote"',
      '"mediaRef"',
      '"mediaUrl"',
      '"mediaAlt"',
      '"settings"',
    ]) {
      expect(payload).not.toContain(hiddenKey);
    }
    for (const secretText of [
      'Secret option',
      'Secret fun fact',
      'secret-photo',
      'correctIndexes',
    ]) {
      expect(payload).not.toContain(secretText);
    }
  });

  it('carries the stored slice count of a wheel row and null on every other row', () => {
    const quiz = quizWithSecrets();
    const [quizRound, wheelRound] = quiz.rounds;
    if (!quizRound || !wheelRound) throw new Error('The fixture has two rows');
    // A stray count on a quiz row and a stored count on the wheel.
    quizRound.settings = { ...quizRound.settings, sliceCount: 4 };
    wheelRound.settings = { ...wheelRound.settings, sliceCount: 3 };
    const preview = toTemplatePreview(
      {
        id: TEMPLATE_ID,
        card_title_en: 'Pride and queer history',
        card_title_pt: 'Orgulho e história queer',
        card_description_en: 'From Stonewall to today',
        card_description_pt: 'De Stonewall até hoje',
        quiz_id: 'quiz-1',
      },
      quiz,
    );

    expect(preview.rounds.map((round) => round.sliceCount)).toEqual([null, 3]);
  });

  it('exports the display name helper, which reads a gone account as null', () => {
    expect(nameOf('Rui', 'Matos')).toBe('Rui Matos');
    expect(nameOf('Rui', null)).toBe('Rui');
    expect(nameOf(null, null)).toBeNull();
  });

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
