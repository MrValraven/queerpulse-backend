import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowTemplateRecord } from './entities/quizshow-template.entity';
import { QuizshowTemplateInputDto } from './dto/quizshow-template.dto';
import { quizshowError, quizshowErrorWithDetails } from './quizshow-errors';
import { toQuizShape } from './quizshow-quiz-mapping';
import {
  QuizshowQuizService,
  type QuizshowQuizTarget,
} from './quizshow-quiz.service';
import {
  completenessProblems,
  structuralProblems,
} from './quizshow-quiz-validation';
import {
  TEMPLATE_CARDS_SQL,
  TEMPLATE_DETAIL_SQL,
  TEMPLATE_ROWS_SQL,
  missingCardFields,
  templateAuditName,
  toTemplateCard,
  toTemplateDetail,
  toTemplateRow,
  withCopySuffix,
  type TemplateCardRow,
  type TemplateDetailRow,
  type TemplateListRow,
} from './quizshow-template-reads';
import type {
  QuizshowQuiz,
  QuizshowQuizShape,
  QuizshowTemplateCard,
  QuizshowTemplateCardText,
  QuizshowTemplateDetail,
  QuizshowTemplateRow,
} from './quizshow.contract';

/** Moderation audit action codes for publishing, unpublishing and deleting a template. */
export const QUIZSHOW_TEMPLATE_AUDIT_ACTIONS = {
  published: 'quizshow_template_published',
  unpublished: 'quizshow_template_unpublished',
  deleted: 'quizshow_template_deleted',
} as const;

const NEW_TEMPLATE_CARD: QuizshowTemplateCardText = {
  title: { en: 'New template', pt: 'Novo modelo' },
  description: { en: '', pt: '' },
};

const NEW_TEMPLATE_QUIZ: QuizshowQuizShape = {
  title: 'New template',
  languages: 'both',
  screenLanguage: 'en',
  rounds: [],
};

function cardTextOf(
  template: QuizshowTemplateRecord,
): QuizshowTemplateCardText {
  return {
    title: { en: template.cardTitleEn, pt: template.cardTitlePt },
    description: {
      en: template.cardDescriptionEn,
      pt: template.cardDescriptionPt,
    },
  };
}

function cardColumnsOf(
  card: QuizshowTemplateCardText,
): Pick<
  QuizshowTemplateRecord,
  'cardTitleEn' | 'cardTitlePt' | 'cardDescriptionEn' | 'cardDescriptionPt'
> {
  return {
    cardTitleEn: card.title.en,
    cardTitlePt: card.title.pt,
    cardDescriptionEn: card.description.en,
    cardDescriptionPt: card.description.pt,
  };
}

/** A malformed id reads as a missing template, before any query runs. */
function assertTemplateId(templateId: string): void {
  if (!isUUID(templateId)) throw quizshowError('quizshow_template_not_found');
}

/**
 * Staff quiz templates: Moderators and Admins with Pulse Live access, as the
 * controller enforces. Drafts are seen by staff only. Publishing is the fact
 * check step: it refuses an incomplete card or a quiz with problems, and
 * stamps the date and the staff member. Hosts see the cards of published
 * templates only, and an import copies the quiz into the host's own event or
 * game. Publish, a state changing unpublish and delete each write a mod audit
 * row in the same transaction.
 */
@Injectable()
export class QuizshowTemplatesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly quizzes: QuizshowQuizService,
    private readonly modAudit: ModAuditService,
  ) {}

  async listTemplateRows(): Promise<{ items: QuizshowTemplateRow[] }> {
    const rows: TemplateListRow[] =
      await this.dataSource.query(TEMPLATE_ROWS_SQL);
    return { items: rows.map(toTemplateRow) };
  }

  async listPublishedCards(): Promise<{ items: QuizshowTemplateCard[] }> {
    const rows: TemplateCardRow[] =
      await this.dataSource.query(TEMPLATE_CARDS_SQL);
    return { items: rows.map(toTemplateCard) };
  }

  /** A draft with the default card, no notes and a blank quiz. */
  async createTemplate(userId: string): Promise<QuizshowTemplateDetail> {
    const templateId = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const insertedId = await this.insertTemplate(manager, {
          card: NEW_TEMPLATE_CARD,
          staffNotes: '',
        });
        await this.quizzes.writeQuiz(
          {
            target: { kind: 'template', templateId: insertedId },
            userId,
            shape: NEW_TEMPLATE_QUIZ,
            sourceTemplateId: null,
            expectedUpdatedAt: undefined,
          },
          manager,
        );
        return insertedId;
      },
    );
    return this.readDetail(templateId);
  }

  /** A draft copy: suffixed card titles, the same description, notes and quiz, and no source. */
  async duplicateTemplate(
    templateId: string,
    userId: string,
  ): Promise<QuizshowTemplateDetail> {
    assertTemplateId(templateId);
    const copyId = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const source = await this.loadTemplate(templateId, manager);
        const sourceQuiz = await this.loadTemplateQuiz(templateId, manager);
        const sourceCard = cardTextOf(source);
        const insertedId = await this.insertTemplate(manager, {
          card: {
            title: withCopySuffix(sourceCard.title),
            description: sourceCard.description,
          },
          staffNotes: source.staffNotes,
        });
        await this.quizzes.writeQuiz(
          {
            target: { kind: 'template', templateId: insertedId },
            userId,
            shape: toQuizShape(sourceQuiz),
            sourceTemplateId: null,
            expectedUpdatedAt: undefined,
          },
          manager,
        );
        return insertedId;
      },
    );
    return this.readDetail(copyId);
  }

  async getTemplate(templateId: string): Promise<QuizshowTemplateDetail> {
    assertTemplateId(templateId);
    return this.readDetail(templateId);
  }

  /**
   * Saves the card, the notes and the quiz in one transaction. The quiz write
   * is guarded by `quiz.expectedUpdatedAt`; a stale token answers quiz changed
   * with the current `updatedAt` and rolls the card and notes back too.
   */
  async replaceTemplate(
    templateId: string,
    userId: string,
    input: QuizshowTemplateInputDto,
  ): Promise<QuizshowTemplateDetail> {
    assertTemplateId(templateId);
    // Sound because IsQuizshowAnswerForType fixes each answer's shape and structuralProblems rejects the rest.
    const inputShape = input.quiz as unknown as QuizshowQuizShape;
    const target: QuizshowQuizTarget = { kind: 'template', templateId };
    await this.dataSource.transaction(async (manager: EntityManager) => {
      // Serialises the save with a publish, which validates the quiz under its own lock.
      await this.loadTemplate(templateId, manager, 'for_no_key_update');
      const storedQuiz = await this.loadTemplateQuiz(templateId, manager);
      this.quizzes.assertShapeAllowed(target, inputShape);
      const storedMediaRefs = storedQuiz.rounds.flatMap((round) =>
        round.questions.map((question) => question.mediaRef),
      );
      for (const round of inputShape.rounds) {
        for (const question of round.questions) {
          assertNoForeignUploadIntroduced(
            userId,
            question.mediaRef,
            storedMediaRefs,
          );
        }
      }
      await this.quizzes.writeQuiz(
        {
          target,
          userId,
          shape: inputShape,
          sourceTemplateId: null,
          expectedUpdatedAt: input.quiz.expectedUpdatedAt,
        },
        manager,
      );
      await manager.update(
        QuizshowTemplateRecord,
        { id: templateId },
        { ...cardColumnsOf(input.card), staffNotes: input.staffNotes },
      );
    });
    return this.readDetail(templateId);
  }

  /**
   * Checks the card, then the quiz, and stamps the publish date and the staff
   * member. Republishing stamps them again. The quiz `updatedAt` stays as it is.
   */
  async publishTemplate(
    templateId: string,
    userId: string,
  ): Promise<QuizshowTemplateDetail> {
    assertTemplateId(templateId);
    await this.dataSource.transaction(async (manager: EntityManager) => {
      const template = await this.loadTemplate(
        templateId,
        manager,
        'pessimistic_write',
      );
      const quiz = await this.loadTemplateQuiz(templateId, manager);
      const card = cardTextOf(template);
      const missing = missingCardFields(card, quiz.languages);
      if (missing.length > 0) {
        throw quizshowErrorWithDetails('quizshow_template_card_incomplete', {
          missing,
        });
      }
      const problems = [
        ...structuralProblems(quiz),
        ...completenessProblems(quiz),
      ];
      if (problems.length > 0) {
        throw quizshowErrorWithDetails('quizshow_quiz_invalid', { problems });
      }
      await manager.update(
        QuizshowTemplateRecord,
        { id: templateId },
        { publishedAt: new Date(), publishedByUserId: userId },
      );
      await this.modAudit.writeAuditLog(
        null,
        userId,
        QUIZSHOW_TEMPLATE_AUDIT_ACTIONS.published,
        undefined,
        templateAuditName(card, templateId),
        undefined,
        manager,
        null,
      );
    });
    return this.readDetail(templateId);
  }

  /** Back to draft with an audit row; a draft answers its detail with no write. */
  async unpublishTemplate(
    templateId: string,
    userId: string,
  ): Promise<QuizshowTemplateDetail> {
    assertTemplateId(templateId);
    await this.dataSource.transaction(async (manager: EntityManager) => {
      const template = await this.loadTemplate(
        templateId,
        manager,
        'pessimistic_write',
      );
      if (template.publishedAt === null) return;
      await manager.update(
        QuizshowTemplateRecord,
        { id: templateId },
        { publishedAt: null, publishedByUserId: null },
      );
      await this.modAudit.writeAuditLog(
        null,
        userId,
        QUIZSHOW_TEMPLATE_AUDIT_ACTIONS.unpublished,
        undefined,
        templateAuditName(cardTextOf(template), templateId),
        undefined,
        manager,
        null,
      );
    });
    return this.readDetail(templateId);
  }

  /** Deletes the template; the database deletes its quiz and clears the source of host copies. */
  async deleteTemplate(templateId: string, userId: string): Promise<void> {
    assertTemplateId(templateId);
    await this.dataSource.transaction(async (manager: EntityManager) => {
      const template = await this.loadTemplate(templateId, manager);
      await manager.delete(QuizshowTemplateRecord, { id: templateId });
      await this.modAudit.writeAuditLog(
        null,
        userId,
        QUIZSHOW_TEMPLATE_AUDIT_ACTIONS.deleted,
        undefined,
        templateAuditName(cardTextOf(template), templateId),
        undefined,
        manager,
        null,
      );
    });
  }

  private async insertTemplate(
    manager: EntityManager,
    values: { card: QuizshowTemplateCardText; staffNotes: string },
  ): Promise<string> {
    const insertResult = await manager.insert(QuizshowTemplateRecord, {
      ...cardColumnsOf(values.card),
      staffNotes: values.staffNotes,
      publishedAt: null,
      publishedByUserId: null,
    });
    return (insertResult.identifiers[0] as { id: string }).id;
  }

  private async loadTemplate(
    templateId: string,
    manager: EntityManager,
    lockMode?: 'pessimistic_write' | 'for_no_key_update',
  ): Promise<QuizshowTemplateRecord> {
    const template = await manager.findOne(QuizshowTemplateRecord, {
      where: { id: templateId },
      ...(lockMode === undefined ? {} : { lock: { mode: lockMode } }),
    });
    if (!template) throw quizshowError('quizshow_template_not_found');
    return template;
  }

  /** The template's quiz row by template id, assembled with its rounds and questions. */
  private async loadTemplateQuiz(
    templateId: string,
    manager: EntityManager,
  ): Promise<QuizshowQuiz> {
    const quizRow = await manager.findOne(QuizshowQuizRecord, {
      where: { templateId },
    });
    const quiz = quizRow
      ? await this.quizzes.loadQuizById(quizRow.id, manager)
      : null;
    if (!quiz) throw quizshowError('quizshow_template_not_found');
    return quiz;
  }

  private async readDetail(
    templateId: string,
  ): Promise<QuizshowTemplateDetail> {
    const rows: TemplateDetailRow[] = await this.dataSource.query(
      TEMPLATE_DETAIL_SQL,
      [templateId],
    );
    const row = rows[0];
    const quiz = row ? await this.quizzes.loadQuizById(row.quiz_id) : null;
    if (!row || !quiz) throw quizshowError('quizshow_template_not_found');
    return toTemplateDetail(row, quiz);
  }
}
