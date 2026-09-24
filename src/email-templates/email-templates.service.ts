import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import type { EmailTemplateLocales } from './email-template-content';
import type { EmailTemplatePurpose } from './email-template-purposes';
import {
  EmailTemplateAdminDTO,
  EmailTemplateDTO,
  toEmailTemplate,
  toEmailTemplateAdmin,
} from './email-template-response';
import { validateEmailTemplateLocales } from './email-template-validation';
import { EmailTemplate } from './entities/email-template.entity';

export interface EmailTemplateWriteInput {
  label: string;
  purpose: EmailTemplatePurpose;
  locales: unknown;
  sortOrder?: number;
  isActive?: boolean;
}

@Injectable()
export class EmailTemplatesService {
  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templates: Repository<EmailTemplate>,
  ) {}

  /** Moderator read for the copy action: active templates for one purpose, in
   *  the order an admin arranged them. */
  async listActive(
    purpose?: EmailTemplatePurpose,
  ): Promise<EmailTemplateDTO[]> {
    const rows = await this.templates.find({
      where: purpose ? { isActive: true, purpose } : { isActive: true },
      order: { sortOrder: 'ASC', label: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toEmailTemplate);
  }

  async listAll(): Promise<EmailTemplateAdminDTO[]> {
    const rows = await this.templates.find({
      order: { purpose: 'ASC', sortOrder: 'ASC', label: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toEmailTemplateAdmin);
  }

  async findOne(id: string): Promise<EmailTemplateAdminDTO> {
    return toEmailTemplateAdmin(await this.requireRow(id));
  }

  async create(
    input: EmailTemplateWriteInput,
    authorUserId: string,
  ): Promise<EmailTemplateAdminDTO> {
    const locales = this.validLocales(input.locales, input.purpose);
    try {
      const saved = await this.templates.save(
        this.templates.create({
          label: input.label.trim(),
          purpose: input.purpose,
          locales,
          sortOrder: input.sortOrder ?? (await this.nextSortOrder()),
          isActive: input.isActive ?? true,
          createdByUserId: authorUserId,
          updatedByUserId: authorUserId,
        }),
      );
      return toEmailTemplateAdmin(saved);
    } catch (error) {
      throw this.asLabelConflict(error);
    }
  }

  async update(
    id: string,
    input: Partial<EmailTemplateWriteInput>,
    editorUserId: string,
  ): Promise<EmailTemplateAdminDTO> {
    const template = await this.requireRow(id);
    // A purpose change re-checks the STORED content too: switching to a
    // purpose with fewer placeholders must not leave unresolvable tokens.
    if (input.locales !== undefined || input.purpose !== undefined) {
      const purpose = input.purpose ?? template.purpose;
      template.locales = this.validLocales(
        input.locales ?? template.locales,
        purpose,
      );
      template.purpose = purpose;
    }
    if (input.label !== undefined) template.label = input.label.trim();
    if (input.sortOrder !== undefined) template.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) template.isActive = input.isActive;
    template.updatedByUserId = editorUserId;
    try {
      return toEmailTemplateAdmin(await this.templates.save(template));
    } catch (error) {
      throw this.asLabelConflict(error);
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.templates.delete({ id });
    if (!result.affected)
      throw new NotFoundException('Email template not found');
  }

  private async requireRow(id: string): Promise<EmailTemplate> {
    const template = await this.templates.findOne({ where: { id } });
    if (!template) throw new NotFoundException('Email template not found');
    return template;
  }

  private validLocales(
    locales: unknown,
    purpose: EmailTemplatePurpose,
  ): EmailTemplateLocales {
    const result = validateEmailTemplateLocales(locales, purpose);
    if (!result.isValid) throw new BadRequestException(result.errors);
    return result.locales;
  }

  private async nextSortOrder(): Promise<number> {
    const last = await this.templates.find({
      order: { sortOrder: 'DESC' },
      take: 1,
    });
    const lastRow = last[0];
    return lastRow ? lastRow.sortOrder + 1 : 0;
  }

  private asLabelConflict(error: unknown): unknown {
    if (isUniqueViolation(error, 'UQ_email_templates_label')) {
      return new ConflictException(
        'An email template with that name already exists',
      );
    }
    return error;
  }
}
