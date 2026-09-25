// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import type { EmailTemplateLocales } from '../email-templates/email-template-content';
import { emailTemplatesSeed } from '../email-templates/email-templates.seed';

const WELCOME_LABEL = 'Welcome: invite approved';

/** The welcome copy `SeedEmailTemplates1821800100000` first inserted, kept
 *  here word for word so `down()` can put it back. */
const PREVIOUS_WELCOME_LOCALES: EmailTemplateLocales = {
  en: {
    subject: 'Your QueerPulse invite is ready',
    mode: 'blocks',
    html: null,
    blocks: [
      {
        id: 'welcome-en-heading',
        type: 'heading',
        level: 1,
        text: 'Welcome to QueerPulse, {name}',
      },
      {
        id: 'welcome-en-intro',
        type: 'paragraph',
        text: 'Thanks for asking to join. We read your request and we would love to have you here.',
      },
      {
        id: 'welcome-en-button',
        type: 'button',
        label: 'Join QueerPulse',
        href: '{inviteLink}',
      },
      {
        id: 'welcome-en-expiry',
        type: 'paragraph',
        text: 'This link is yours alone and works until {expiresOn}. If it runs out before you get to it, reply to this email and we will send a fresh one.',
      },
      {
        id: 'welcome-en-signoff',
        type: 'paragraph',
        text: 'See you inside,\nThe QueerPulse team',
      },
    ],
  },
  pt: {
    subject: 'O teu convite para o QueerPulse está pronto',
    mode: 'blocks',
    html: null,
    blocks: [
      {
        id: 'welcome-pt-heading',
        type: 'heading',
        level: 1,
        text: 'Bem-vinde ao QueerPulse, {name}',
      },
      {
        id: 'welcome-pt-intro',
        type: 'paragraph',
        text: 'Obrigado por pedires para entrar. Lemos o teu pedido e adorávamos ter-te cá.',
      },
      {
        id: 'welcome-pt-button',
        type: 'button',
        label: 'Entrar no QueerPulse',
        href: '{inviteLink}',
      },
      {
        id: 'welcome-pt-expiry',
        type: 'paragraph',
        text: 'Este link é só teu e funciona até {expiresOn}. Se expirar antes de o usares, responde a este email e enviamos-te um novo.',
      },
      {
        id: 'welcome-pt-signoff',
        type: 'paragraph',
        text: 'Até já,\nA equipa QueerPulse',
      },
    ],
  },
};

/**
 * Moves the seeded welcome email onto the redesigned copy in
 * `email-templates.seed.ts` (hero, invite ticket, feature list, signature and
 * a preheader). `SeedEmailTemplates1821800100000` inserts only when the label
 * is missing, so databases that already ran it still hold the old copy.
 *
 * Only a row no admin has saved is touched: every admin write stamps
 * `updated_by_user_id`, so `IS NULL` means the row is still the seed's. That
 * column is `ON DELETE SET NULL`, so `up()` also requires `updated_at` to still
 * equal `created_at` (the seed insert sets both to the same `now()`); an edit
 * by a since-deleted admin keeps its copy. `down()` checks only the user
 * column, because `up()` itself moves `updated_at`.
 */
export class UpdateWelcomeEmailTemplate1821800200000 implements MigrationInterface {
  name = 'UpdateWelcomeEmailTemplate1821800200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const welcome = emailTemplatesSeed.find(
      (template) => template.label === WELCOME_LABEL,
    );
    if (!welcome) {
      throw new Error(`No seed template labelled "${WELCOME_LABEL}"`);
    }
    await this.replaceUneditedWelcome(
      queryRunner,
      welcome.locales,
      'AND "updated_at" = "created_at"',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replaceUneditedWelcome(
      queryRunner,
      PREVIOUS_WELCOME_LOCALES,
      '',
    );
  }

  private async replaceUneditedWelcome(
    queryRunner: QueryRunner,
    locales: EmailTemplateLocales,
    extraCondition: string,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE "email_templates"
          SET "locales" = $2::jsonb, "updated_at" = now()
        WHERE "label" = $1 AND "updated_by_user_id" IS NULL ${extraCondition}`,
      [WELCOME_LABEL, JSON.stringify(locales)],
    );
  }
}
