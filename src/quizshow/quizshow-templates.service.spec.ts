import { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { ModAuditService } from '../moderation/mod-audit.service';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowTemplateRecord } from './entities/quizshow-template.entity';
import type { QuizshowTemplateInputDto } from './dto/quizshow-template.dto';
import { quizshowCodeOf, quizshowErrorWithDetails } from './quizshow-errors';
import { toQuizShape } from './quizshow-quiz-mapping';
import type {
  QuizshowQuizService,
  QuizshowQuizWriteInput,
} from './quizshow-quiz.service';
import {
  TEMPLATE_CARDS_SQL,
  TEMPLATE_DETAIL_SQL,
  TEMPLATE_ROWS_SQL,
  type TemplateCardRow,
  type TemplateListRow,
} from './quizshow-template-reads';
import {
  QUIZSHOW_TEMPLATE_AUDIT_ACTIONS,
  QuizshowTemplatesService,
} from './quizshow-templates.service';
import type {
  QuizshowQuestionInput,
  QuizshowQuiz,
  QuizshowQuizShape,
  QuizshowRoundInput,
  QuizshowTemplateCardText,
} from './quizshow.contract';

const TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-000000000001';
const UNKNOWN_TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-0000000000ff';
const STAFF_USER_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_STAFF_USER_ID = '00000000-0000-4000-8000-0000000000c2';
const STORED_UPDATED_AT = '2026-10-19T10:00:00.000Z';
const SAVED_UPDATED_AT = '2026-10-27T12:00:00.000Z';
const NEWER_UPDATED_AT = '2026-10-27T13:00:00.000Z';
const EARLIER_PUBLISHED_AT = new Date('2026-10-20T09:00:00.000Z');
const OWN_IMAGE = `event-covers/${STAFF_USER_ID}/00000000-0000-4000-8000-000000000001.jpg`;
const FOREIGN_IMAGE =
  'event-covers/00000000-0000-4000-8000-0000000000aa/00000000-0000-4000-8000-000000000002.jpg';

const STORED_CARD: QuizshowTemplateCardText = {
  title: { en: 'Pride and queer history', pt: 'Orgulho e história queer' },
  description: { en: 'From Stonewall to today', pt: 'De Stonewall até hoje' },
};
const STORED_NOTES = 'Round 1, question 1: checked against the archive';

function multipleChoiceQuestion(
  overrides: Partial<QuizshowQuestionInput> = {},
): QuizshowQuestionInput {
  return {
    type: 'multiple_choice',
    prompt: { en: 'Which one?', pt: 'Qual?' },
    mediaRef: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [
      { id: 'a', text: { en: 'One', pt: 'Um' } },
      { id: 'b', text: { en: 'Two', pt: 'Dois' } },
    ],
    answer: { correctIndex: 0 },
    acceptedAnswers: [],
    ...overrides,
  } as QuizshowQuestionInput;
}

function round(
  overrides: Partial<QuizshowRoundInput> = {},
  questions: QuizshowQuestionInput[] = [multipleChoiceQuestion()],
): QuizshowRoundInput {
  return {
    kind: 'quiz',
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    },
    questions,
    ...overrides,
  };
}

function completeShape(
  overrides: Partial<QuizshowQuizShape> = {},
): QuizshowQuizShape {
  return {
    title: 'Pride night',
    languages: 'both',
    screenLanguage: 'en',
    rounds: [round()],
    ...overrides,
  };
}

function storedQuizOf(
  shape: QuizshowQuizShape,
  updatedAt: string,
): QuizshowQuiz {
  return {
    title: shape.title,
    languages: shape.languages,
    screenLanguage: shape.screenLanguage,
    sourceTemplateId: null,
    updatedAt,
    rounds: shape.rounds.map((storedRound, roundIndex) => ({
      ...storedRound,
      id: `round-${roundIndex}`,
      questions: storedRound.questions.map((question, questionIndex) => ({
        ...question,
        id: `question-${roundIndex}-${questionIndex}`,
        mediaUrl: null,
      })),
    })),
  };
}

function templateInput(
  overrides: {
    card?: QuizshowTemplateCardText;
    staffNotes?: string;
    quiz?: Partial<QuizshowQuizShape> & { expectedUpdatedAt?: string | null };
  } = {},
): QuizshowTemplateInputDto {
  return {
    card: overrides.card ?? STORED_CARD,
    staffNotes: overrides.staffNotes ?? STORED_NOTES,
    quiz: {
      expectedUpdatedAt: STORED_UPDATED_AT,
      ...completeShape(),
      ...overrides.quiz,
    },
  };
}

interface StoredTemplate {
  id: string;
  cardTitleEn: string;
  cardTitlePt: string;
  cardDescriptionEn: string;
  cardDescriptionPt: string;
  staffNotes: string;
  publishedAt: Date | null;
  publishedByUserId: string | null;
}

interface StoredTemplateQuiz {
  id: string;
  templateId: string;
  quiz: QuizshowQuiz;
}

interface FakeStore {
  templates: StoredTemplate[];
  quizzes: StoredTemplateQuiz[];
  profiles: Record<string, { firstName: string; lastName: string }>;
}

function build(
  options: { listRows?: TemplateListRow[]; cardRows?: TemplateCardRow[] } = {},
) {
  const store: FakeStore = {
    templates: [],
    quizzes: [],
    profiles: {
      [STAFF_USER_ID]: { firstName: 'Rui', lastName: 'Matos' },
      [OTHER_STAFF_USER_ID]: { firstName: 'Ana', lastName: 'Lopes' },
    },
  };
  let insertedTemplateCount = 0;
  let insertedQuizCount = 0;
  const manager = {
    findOne: jest.fn(
      (entity: unknown, query: { where: Record<string, unknown> }) => {
        if (entity === QuizshowTemplateRecord) {
          return Promise.resolve(
            store.templates.find(
              (template) => template.id === query.where.id,
            ) ?? null,
          );
        }
        if (entity === QuizshowQuizRecord) {
          const held = store.quizzes.find(
            (storedQuiz) => storedQuiz.templateId === query.where.templateId,
          );
          return Promise.resolve(
            held ? { id: held.id, templateId: held.templateId } : null,
          );
        }
        return Promise.resolve(null);
      },
    ),
    insert: jest.fn((entity: unknown, values: object) => {
      if (entity !== QuizshowTemplateRecord) {
        return Promise.resolve({ identifiers: [] });
      }
      insertedTemplateCount += 1;
      const id = `a7e3b1c0-5eed-4000-8000-0000000001${String(insertedTemplateCount).padStart(2, '0')}`;
      store.templates.push({ id, ...(values as Omit<StoredTemplate, 'id'>) });
      return Promise.resolve({ identifiers: [{ id }] });
    }),
    update: jest.fn(
      (entity: unknown, criteria: { id: string }, columns: object) => {
        if (entity === QuizshowTemplateRecord) {
          const stored = store.templates.find(
            (template) => template.id === criteria.id,
          );
          if (stored) Object.assign(stored, columns);
        }
        return Promise.resolve({ affected: 1 });
      },
    ),
    delete: jest.fn((entity: unknown, criteria: { id: string }) => {
      if (entity === QuizshowTemplateRecord) {
        // The database cascades the template's quiz.
        store.templates = store.templates.filter(
          (template) => template.id !== criteria.id,
        );
        store.quizzes = store.quizzes.filter(
          (storedQuiz) => storedQuiz.templateId !== criteria.id,
        );
      }
      return Promise.resolve({ affected: 1 });
    }),
  };
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const dataSource = {
    transaction: jest.fn(
      (work: (entityManager: typeof manager) => Promise<unknown>) =>
        work(manager),
    ),
    query: jest.fn((sql: string, parameters: unknown[] = []) => {
      queries.push({ sql, parameters });
      if (sql === TEMPLATE_ROWS_SQL) {
        return Promise.resolve(options.listRows ?? []);
      }
      if (sql === TEMPLATE_CARDS_SQL) {
        return Promise.resolve(options.cardRows ?? []);
      }
      if (sql === TEMPLATE_DETAIL_SQL) {
        const template = store.templates.find(
          (stored) => stored.id === parameters[0],
        );
        const held = store.quizzes.find(
          (storedQuiz) => storedQuiz.templateId === parameters[0],
        );
        if (!template || !held) return Promise.resolve([]);
        const publisher = template.publishedByUserId
          ? store.profiles[template.publishedByUserId]
          : undefined;
        return Promise.resolve([
          {
            id: template.id,
            card_title_en: template.cardTitleEn,
            card_title_pt: template.cardTitlePt,
            card_description_en: template.cardDescriptionEn,
            card_description_pt: template.cardDescriptionPt,
            staff_notes: template.staffNotes,
            published_at: template.publishedAt,
            quiz_id: held.id,
            first_name: publisher?.firstName ?? null,
            last_name: publisher?.lastName ?? null,
          },
        ]);
      }
      return Promise.resolve([]);
    }),
  };
  const writeQuiz = jest.fn((input: QuizshowQuizWriteInput) => {
    if (input.target.kind !== 'template') {
      return Promise.reject(new Error('Only template targets are expected'));
    }
    const templateId = input.target.templateId;
    const quiz = storedQuizOf(input.shape, SAVED_UPDATED_AT);
    const held = store.quizzes.find(
      (storedQuiz) => storedQuiz.templateId === templateId,
    );
    if (held) {
      held.quiz = quiz;
      return Promise.resolve(held.id);
    }
    insertedQuizCount += 1;
    const quizId = `quiz-${insertedQuizCount}`;
    store.quizzes.push({ id: quizId, templateId, quiz });
    return Promise.resolve(quizId);
  });
  const quizzes = {
    writeQuiz,
    assertShapeAllowed: jest.fn(),
    loadQuizById: jest.fn((quizId: string) =>
      Promise.resolve(
        store.quizzes.find((storedQuiz) => storedQuiz.id === quizId)?.quiz ??
          null,
      ),
    ),
  };
  const modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
  const service = new QuizshowTemplatesService(
    dataSource as unknown as DataSource,
    quizzes as unknown as QuizshowQuizService,
    modAudit as unknown as ModAuditService,
  );
  return {
    service,
    store,
    manager,
    dataSource,
    queries,
    quizzes,
    writeQuiz,
    modAudit,
  };
}

function seedTemplate(
  store: FakeStore,
  overrides: Partial<StoredTemplate> = {},
  quiz: QuizshowQuiz = storedQuizOf(completeShape(), STORED_UPDATED_AT),
): StoredTemplate {
  const template: StoredTemplate = {
    id: TEMPLATE_ID,
    cardTitleEn: STORED_CARD.title.en,
    cardTitlePt: STORED_CARD.title.pt,
    cardDescriptionEn: STORED_CARD.description.en,
    cardDescriptionPt: STORED_CARD.description.pt,
    staffNotes: STORED_NOTES,
    publishedAt: null,
    publishedByUserId: null,
    ...overrides,
  };
  store.templates.push(template);
  store.quizzes.push({
    id: `quiz-of-${template.id}`,
    templateId: template.id,
    quiz,
  });
  return template;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

function bodyOf(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getResponse() as Record<string, unknown>;
}

function statusOf(error: unknown): number {
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getStatus();
}

function templateUpdateCalls(
  manager: ReturnType<typeof build>['manager'],
): unknown[][] {
  return manager.update.mock.calls.filter(
    ([entity]) => entity === QuizshowTemplateRecord,
  );
}

describe('QuizshowTemplatesService', () => {
  it('creates a draft with the default card and a blank quiz', async () => {
    const { service, manager, writeQuiz, dataSource } = build();

    const detail = await service.createTemplate(STAFF_USER_ID);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.insert).toHaveBeenCalledWith(QuizshowTemplateRecord, {
      cardTitleEn: 'New template',
      cardTitlePt: 'Novo modelo',
      cardDescriptionEn: '',
      cardDescriptionPt: '',
      staffNotes: '',
      publishedAt: null,
      publishedByUserId: null,
    });
    expect(writeQuiz).toHaveBeenCalledTimes(1);
    const [writeInput, writeManager] = writeQuiz.mock.calls[0] as unknown as [
      QuizshowQuizWriteInput,
      unknown,
    ];
    expect(writeInput).toEqual({
      target: { kind: 'template', templateId: detail.id },
      userId: STAFF_USER_ID,
      shape: {
        title: 'New template',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [],
      },
      sourceTemplateId: null,
      expectedUpdatedAt: undefined,
    });
    expect(Object.keys(writeInput)).toContain('expectedUpdatedAt');
    expect(writeInput.expectedUpdatedAt).toBeUndefined();
    expect(writeManager).toBe(manager);
    expect(detail.status).toBe('draft');
    expect(detail.publishedAt).toBeNull();
    expect(detail.publishedByName).toBeNull();
    expect(detail.card).toEqual({
      title: { en: 'New template', pt: 'Novo modelo' },
      description: { en: '', pt: '' },
    });
    expect(detail.staffNotes).toBe('');
    expect(detail.quiz.rounds).toEqual([]);
  });

  it('answers template not found for a malformed or unknown id', async () => {
    const { service, dataSource, manager, writeQuiz, store } = build();
    const routesFor = (templateId: string): (() => Promise<unknown>)[] => [
      () => service.getTemplate(templateId),
      () => service.duplicateTemplate(templateId, STAFF_USER_ID),
      () => service.replaceTemplate(templateId, STAFF_USER_ID, templateInput()),
      () => service.publishTemplate(templateId, STAFF_USER_ID),
      () => service.unpublishTemplate(templateId, STAFF_USER_ID),
      () => service.deleteTemplate(templateId, STAFF_USER_ID),
    ];

    for (const route of routesFor('not-a-uuid')) {
      const error = await rejectionOf(route());
      expect(quizshowCodeOf(error)).toBe('quizshow_template_not_found');
      expect(statusOf(error)).toBe(404);
    }
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(manager.findOne).not.toHaveBeenCalled();

    for (const route of routesFor(UNKNOWN_TEMPLATE_ID)) {
      const error = await rejectionOf(route());
      expect(quizshowCodeOf(error)).toBe('quizshow_template_not_found');
    }
    expect(writeQuiz).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
    expect(store.templates).toHaveLength(0);
  });

  it('saves card, notes and quiz in one transaction guarded by expectedUpdatedAt', async () => {
    const { service, store, manager, dataSource, writeQuiz, quizzes } = build();
    seedTemplate(store);
    const newCard: QuizshowTemplateCardText = {
      title: { en: 'Queer history', pt: 'História queer' },
      description: { en: 'Updated blurb', pt: 'Resumo novo' },
    };

    const detail = await service.replaceTemplate(
      TEMPLATE_ID,
      STAFF_USER_ID,
      templateInput({
        card: newCard,
        staffNotes: 'Round 1, question 1: rechecked',
        quiz: { title: 'Updated quiz' },
      }),
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(quizzes.assertShapeAllowed).toHaveBeenCalledWith(
      { kind: 'template', templateId: TEMPLATE_ID },
      expect.objectContaining({ title: 'Updated quiz' }),
    );
    expect(writeQuiz).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'template', templateId: TEMPLATE_ID },
        userId: STAFF_USER_ID,
        sourceTemplateId: null,
        expectedUpdatedAt: STORED_UPDATED_AT,
      }),
      manager,
    );
    expect(templateUpdateCalls(manager)).toEqual([
      [
        QuizshowTemplateRecord,
        { id: TEMPLATE_ID },
        {
          cardTitleEn: 'Queer history',
          cardTitlePt: 'História queer',
          cardDescriptionEn: 'Updated blurb',
          cardDescriptionPt: 'Resumo novo',
          staffNotes: 'Round 1, question 1: rechecked',
        },
      ],
    ]);
    expect(writeQuiz.mock.invocationCallOrder[0]).toBeLessThan(
      manager.update.mock.invocationCallOrder[0] ?? 0,
    );
    expect(detail.card).toEqual(newCard);
    expect(detail.staffNotes).toBe('Round 1, question 1: rechecked');
    expect(detail.quiz.title).toBe('Updated quiz');
    expect(detail.quiz.updatedAt).toBe(SAVED_UPDATED_AT);
  });

  it('refuses a stale save with quiz changed and leaves card and notes unchanged', async () => {
    const { service, store, manager, writeQuiz } = build();
    seedTemplate(store);
    writeQuiz.mockRejectedValueOnce(
      quizshowErrorWithDetails('quizshow_quiz_changed', {
        updatedAt: NEWER_UPDATED_AT,
      }),
    );

    const error = await rejectionOf(
      service.replaceTemplate(
        TEMPLATE_ID,
        STAFF_USER_ID,
        templateInput({
          card: {
            title: { en: 'Lost edit', pt: 'Edição perdida' },
            description: STORED_CARD.description,
          },
          staffNotes: 'Lost notes',
        }),
      ),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_quiz_changed');
    expect(statusOf(error)).toBe(409);
    expect(bodyOf(error)).toMatchObject({
      code: 'quizshow_quiz_changed',
      updatedAt: NEWER_UPDATED_AT,
    });
    expect(templateUpdateCalls(manager)).toEqual([]);
    expect(store.templates[0]).toMatchObject({
      cardTitleEn: STORED_CARD.title.en,
      cardTitlePt: STORED_CARD.title.pt,
      staffNotes: STORED_NOTES,
    });
  });

  it('refuses a foreign image the template does not already hold', async () => {
    const { service, store, writeQuiz } = build();
    seedTemplate(store);
    const withForeignImage = templateInput({
      quiz: {
        rounds: [
          round({}, [multipleChoiceQuestion({ mediaRef: FOREIGN_IMAGE })]),
        ],
      },
    });

    await expect(
      service.replaceTemplate(TEMPLATE_ID, STAFF_USER_ID, withForeignImage),
    ).rejects.toThrow('Referenced upload does not belong to you');
    expect(writeQuiz).not.toHaveBeenCalled();

    store.quizzes[0]!.quiz = storedQuizOf(
      completeShape({
        rounds: [
          round({}, [multipleChoiceQuestion({ mediaRef: FOREIGN_IMAGE })]),
        ],
      }),
      STORED_UPDATED_AT,
    );
    await service.replaceTemplate(TEMPLATE_ID, STAFF_USER_ID, withForeignImage);
    expect(writeQuiz).toHaveBeenCalledTimes(1);

    await service.replaceTemplate(
      TEMPLATE_ID,
      STAFF_USER_ID,
      templateInput({
        quiz: {
          expectedUpdatedAt: SAVED_UPDATED_AT,
          rounds: [
            round({}, [multipleChoiceQuestion({ mediaRef: OWN_IMAGE })]),
          ],
        },
      }),
    );
    expect(writeQuiz).toHaveBeenCalledTimes(2);
  });

  it('duplicates a template as a draft with copy suffixes, notes and quiz, and no source', async () => {
    const { service, store, manager, writeQuiz } = build();
    const source = seedTemplate(store, {
      publishedAt: EARLIER_PUBLISHED_AT,
      publishedByUserId: OTHER_STAFF_USER_ID,
    });
    const sourceQuiz = store.quizzes[0]!.quiz;

    const detail = await service.duplicateTemplate(TEMPLATE_ID, STAFF_USER_ID);

    expect(detail.id).not.toBe(TEMPLATE_ID);
    expect(detail.card).toEqual({
      title: {
        en: 'Pride and queer history (copy)',
        pt: 'Orgulho e história queer (cópia)',
      },
      description: STORED_CARD.description,
    });
    expect(detail.staffNotes).toBe(STORED_NOTES);
    expect(detail.status).toBe('draft');
    expect(detail.publishedAt).toBeNull();
    expect(detail.publishedByName).toBeNull();
    expect(writeQuiz).toHaveBeenCalledWith(
      {
        target: { kind: 'template', templateId: detail.id },
        userId: STAFF_USER_ID,
        shape: toQuizShape(sourceQuiz),
        sourceTemplateId: null,
        expectedUpdatedAt: undefined,
      },
      manager,
    );
    expect(detail.quiz.title).toBe('Pride night');
    expect(detail.quiz.sourceTemplateId).toBeNull();
    expect(detail.quiz.rounds).toHaveLength(sourceQuiz.rounds.length);
    expect(source.cardTitleEn).toBe('Pride and queer history');
    expect(source.publishedAt).toBe(EARLIER_PUBLISHED_AT);
  });

  it('publishes a complete template, stamps the date and staff member, and writes the audit row', async () => {
    const { service, store, manager, writeQuiz, modAudit } = build();
    seedTemplate(store);
    const before = Date.now();

    const detail = await service.publishTemplate(TEMPLATE_ID, STAFF_USER_ID);

    const after = Date.now();
    expect(manager.findOne).toHaveBeenCalledWith(QuizshowTemplateRecord, {
      where: { id: TEMPLATE_ID },
      lock: { mode: 'pessimistic_write' },
    });
    const [updateCall] = templateUpdateCalls(manager);
    const columns = updateCall?.[2] as {
      publishedAt: Date;
      publishedByUserId: string;
    };
    expect(Object.keys(columns).sort()).toEqual([
      'publishedAt',
      'publishedByUserId',
    ]);
    expect(columns.publishedAt).toBeInstanceOf(Date);
    expect(columns.publishedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(columns.publishedAt.getTime()).toBeLessThanOrEqual(after);
    expect(columns.publishedByUserId).toBe(STAFF_USER_ID);
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_USER_ID,
      'quizshow_template_published',
      undefined,
      'Pride and queer history',
      undefined,
      manager,
      null,
    );
    expect(writeQuiz).not.toHaveBeenCalled();
    expect(detail.status).toBe('published');
    expect(detail.publishedAt).toBe(columns.publishedAt.toISOString());
    expect(detail.publishedByName).toBe('Rui Matos');
    expect(detail.quiz.updatedAt).toBe(STORED_UPDATED_AT);
  });

  it('refuses to publish with the missing card fields named', async () => {
    const { service, store, manager, modAudit } = build();
    seedTemplate(store, { cardTitlePt: '', cardDescriptionEn: '  ' });

    const bothError = await rejectionOf(
      service.publishTemplate(TEMPLATE_ID, STAFF_USER_ID),
    );
    expect(quizshowCodeOf(bothError)).toBe('quizshow_template_card_incomplete');
    expect(statusOf(bothError)).toBe(422);
    expect(bodyOf(bothError).missing).toEqual(['title.pt', 'description.en']);

    store.quizzes[0]!.quiz = storedQuizOf(
      completeShape({ languages: 'en' }),
      STORED_UPDATED_AT,
    );
    const englishError = await rejectionOf(
      service.publishTemplate(TEMPLATE_ID, STAFF_USER_ID),
    );
    expect(quizshowCodeOf(englishError)).toBe(
      'quizshow_template_card_incomplete',
    );
    expect(bodyOf(englishError).missing).toEqual(['description.en']);
    expect(templateUpdateCalls(manager)).toEqual([]);
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('refuses to publish a blank template with quiz invalid and no_rounds', async () => {
    const { service, store, manager, modAudit } = build();
    seedTemplate(
      store,
      {},
      storedQuizOf(completeShape({ rounds: [] }), STORED_UPDATED_AT),
    );

    const error = await rejectionOf(
      service.publishTemplate(TEMPLATE_ID, STAFF_USER_ID),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_quiz_invalid');
    expect(statusOf(error)).toBe(422);
    expect(bodyOf(error).problems).toContainEqual({
      code: 'no_rounds',
      roundIndex: null,
      questionIndex: null,
      language: null,
    });
    expect(templateUpdateCalls(manager)).toEqual([]);
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    expect(store.templates[0]?.publishedAt).toBeNull();
  });

  it('checks the card first: a blank PT title with no rounds answers card incomplete', async () => {
    const { service, store, manager, modAudit } = build();
    seedTemplate(
      store,
      { cardTitlePt: '' },
      storedQuizOf(completeShape({ rounds: [] }), STORED_UPDATED_AT),
    );

    const error = await rejectionOf(
      service.publishTemplate(TEMPLATE_ID, STAFF_USER_ID),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_template_card_incomplete');
    expect(statusOf(error)).toBe(422);
    expect(bodyOf(error).missing).toEqual(['title.pt']);
    expect(bodyOf(error).problems).toBeUndefined();
    expect(templateUpdateCalls(manager)).toEqual([]);
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    expect(store.templates[0]?.publishedAt).toBeNull();
  });

  it('takes the template row lock before it writes the quiz on save', async () => {
    const { service, store, manager, writeQuiz } = build();
    seedTemplate(store);

    await service.replaceTemplate(TEMPLATE_ID, STAFF_USER_ID, templateInput());

    const lockCallIndex = manager.findOne.mock.calls.findIndex(
      ([entity, query]) =>
        entity === QuizshowTemplateRecord &&
        (query as { lock?: { mode: string } }).lock?.mode ===
          'for_no_key_update',
    );
    expect(lockCallIndex).toBeGreaterThanOrEqual(0);
    expect(manager.findOne).toHaveBeenCalledWith(QuizshowTemplateRecord, {
      where: { id: TEMPLATE_ID },
      lock: { mode: 'for_no_key_update' },
    });
    expect(writeQuiz).toHaveBeenCalledTimes(1);
    expect(
      manager.findOne.mock.invocationCallOrder[lockCallIndex],
    ).toBeLessThan(writeQuiz.mock.invocationCallOrder[0] ?? 0);
  });

  it('republishing sets a new publish date and writes another audit row', async () => {
    const { service, store, modAudit } = build();
    seedTemplate(store, {
      publishedAt: EARLIER_PUBLISHED_AT,
      publishedByUserId: OTHER_STAFF_USER_ID,
    });

    const first = await service.publishTemplate(TEMPLATE_ID, STAFF_USER_ID);
    const second = await service.publishTemplate(TEMPLATE_ID, STAFF_USER_ID);

    expect(new Date(first.publishedAt ?? 0).getTime()).toBeGreaterThan(
      EARLIER_PUBLISHED_AT.getTime(),
    );
    expect(new Date(second.publishedAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(first.publishedAt ?? 0).getTime(),
    );
    expect(second.publishedByName).toBe('Rui Matos');
    expect(store.templates[0]?.publishedByUserId).toBe(STAFF_USER_ID);
    expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(2);
    const auditCalls = modAudit.writeAuditLog.mock.calls as unknown[][];
    for (const auditCall of auditCalls) {
      expect(auditCall[2]).toBe(QUIZSHOW_TEMPLATE_AUDIT_ACTIONS.published);
    }
  });

  it('unpublishes with an audit row and answers a draft unpublish with no write', async () => {
    const { service, store, manager, modAudit } = build();
    seedTemplate(store, {
      publishedAt: EARLIER_PUBLISHED_AT,
      publishedByUserId: STAFF_USER_ID,
    });

    const detail = await service.unpublishTemplate(TEMPLATE_ID, STAFF_USER_ID);

    expect(detail.status).toBe('draft');
    expect(detail.publishedAt).toBeNull();
    expect(detail.publishedByName).toBeNull();
    expect(detail.quiz.updatedAt).toBe(STORED_UPDATED_AT);
    expect(templateUpdateCalls(manager)).toEqual([
      [
        QuizshowTemplateRecord,
        { id: TEMPLATE_ID },
        { publishedAt: null, publishedByUserId: null },
      ],
    ]);
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_USER_ID,
      'quizshow_template_unpublished',
      undefined,
      'Pride and queer history',
      undefined,
      manager,
      null,
    );

    const draftDetail = await service.unpublishTemplate(
      TEMPLATE_ID,
      STAFF_USER_ID,
    );

    expect(draftDetail.status).toBe('draft');
    expect(draftDetail.id).toBe(TEMPLATE_ID);
    expect(templateUpdateCalls(manager)).toHaveLength(1);
    expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it('deletes a template with an audit row naming its EN card title', async () => {
    const { service, store, manager, modAudit } = build();
    seedTemplate(store, {
      publishedAt: EARLIER_PUBLISHED_AT,
      publishedByUserId: STAFF_USER_ID,
    });

    await service.deleteTemplate(TEMPLATE_ID, STAFF_USER_ID);

    expect(manager.delete).toHaveBeenCalledWith(QuizshowTemplateRecord, {
      id: TEMPLATE_ID,
    });
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_USER_ID,
      'quizshow_template_deleted',
      undefined,
      'Pride and queer history',
      undefined,
      manager,
      null,
    );
    expect(store.templates).toHaveLength(0);
    expect(store.quizzes).toHaveLength(0);
    const error = await rejectionOf(service.getTemplate(TEMPLATE_ID));
    expect(quizshowCodeOf(error)).toBe('quizshow_template_not_found');
  });

  it('lists drafts first, then published, each by last edit', async () => {
    const editedAt = new Date('2026-10-26T18:30:00.000Z');
    const publishedAt = new Date('2026-10-25T08:00:00.000Z');
    const { service, queries } = build({
      listRows: [
        {
          id: 'a7e3b1c0-5eed-4000-8000-0000000000d6',
          card_title_en: 'Queer cinema',
          card_title_pt: 'Cinema queer',
          published_at: null,
          updated_at: editedAt,
          editor_first_name: 'Rui',
          editor_last_name: 'Matos',
          round_count: 2,
          question_count: 6,
          has_adults_rounds: false,
        },
        {
          id: TEMPLATE_ID,
          card_title_en: 'Pride and queer history',
          card_title_pt: 'Orgulho e história queer',
          published_at: publishedAt,
          updated_at: '2026-10-24T10:00:00.000Z',
          editor_first_name: 'Rui',
          editor_last_name: 'Matos',
          round_count: 4,
          question_count: 16,
          has_adults_rounds: true,
        },
      ],
    });

    const { items } = await service.listTemplateRows();

    expect(queries[0]?.sql).toContain(
      'ORDER BY ("template"."published_at" IS NOT NULL) ASC, "quiz"."updated_at" DESC, "template"."id" ASC',
    );
    expect(queries[0]?.sql).toContain(
      'LEFT JOIN "profiles" "editor" ON "editor"."user_id" = "quiz"."updated_by_user_id"',
    );
    expect(items).toEqual([
      {
        id: 'a7e3b1c0-5eed-4000-8000-0000000000d6',
        title: { en: 'Queer cinema', pt: 'Cinema queer' },
        status: 'draft',
        roundCount: 2,
        questionCount: 6,
        hasAdultsRounds: false,
        updatedAt: editedAt.toISOString(),
        updatedByName: 'Rui Matos',
        publishedAt: null,
      },
      {
        id: TEMPLATE_ID,
        title: {
          en: 'Pride and queer history',
          pt: 'Orgulho e história queer',
        },
        status: 'published',
        roundCount: 4,
        questionCount: 16,
        hasAdultsRounds: true,
        updatedAt: '2026-10-24T10:00:00.000Z',
        updatedByName: 'Rui Matos',
        publishedAt: publishedAt.toISOString(),
      },
    ]);
  });

  it('lists a template whose editor account is gone with null names', async () => {
    const { service, store } = build({
      listRows: [
        {
          id: TEMPLATE_ID,
          card_title_en: 'Pride and queer history',
          card_title_pt: 'Orgulho e história queer',
          published_at: null,
          updated_at: STORED_UPDATED_AT,
          editor_first_name: null,
          editor_last_name: null,
          round_count: 1,
          question_count: 1,
          has_adults_rounds: false,
        },
      ],
    });

    const { items } = await service.listTemplateRows();
    expect(items[0]?.updatedByName).toBeNull();

    seedTemplate(store, {
      publishedAt: EARLIER_PUBLISHED_AT,
      publishedByUserId: null,
    });
    const detail = await service.getTemplate(TEMPLATE_ID);
    expect(detail.status).toBe('published');
    expect(detail.publishedByName).toBeNull();
  });

  it('lists only published template cards with no notes or answers', async () => {
    const { service, queries } = build({
      cardRows: [
        {
          id: TEMPLATE_ID,
          card_title_en: 'Pride and queer history',
          card_title_pt: 'Orgulho e história queer',
          card_description_en: 'From Stonewall to today',
          card_description_pt: 'De Stonewall até hoje',
          languages: 'both',
          round_count: 4,
          question_count: 16,
          has_adults_rounds: false,
        },
      ],
    });

    const { items } = await service.listPublishedCards();

    const cardsSql = queries[0]?.sql ?? '';
    expect(cardsSql).toContain('"template"."published_at" IS NOT NULL');
    expect(cardsSql).toContain(
      'ORDER BY "template"."published_at" ASC, "template"."id" ASC',
    );
    expect(cardsSql).not.toContain('staff_notes');
    expect(cardsSql).not.toContain('"answer"');
    expect(items).toHaveLength(1);
    const card = items[0]!;
    expect(Object.keys(card).sort()).toEqual([
      'description',
      'hasAdultsRounds',
      'id',
      'languages',
      'questionCount',
      'roundCount',
      'title',
    ]);
    expect(card).toEqual({
      id: TEMPLATE_ID,
      title: { en: 'Pride and queer history', pt: 'Orgulho e história queer' },
      description: {
        en: 'From Stonewall to today',
        pt: 'De Stonewall até hoje',
      },
      languages: 'both',
      roundCount: 4,
      questionCount: 16,
      hasAdultsRounds: false,
    });
  });
});
