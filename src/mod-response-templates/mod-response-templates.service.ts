import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import type { ReasonCode } from '../reports/reason-catalogue';
import type { ModActionCode } from '../moderation/dto/mod-action.dto';
import { ModResponseTemplate } from './entities/mod-response-template.entity';
import {
  ModResponseTemplateAdminDTO,
  ModResponseTemplateDTO,
  toModResponseTemplate,
  toModResponseTemplateAdmin,
} from './mod-response-template-response';
import {
  TEMPLATE_PLACEHOLDERS,
  unknownPlaceholders,
} from './mod-response-template-placeholders';

export interface ModResponseTemplateWriteInput {
  label: string;
  body: string;
  reasonCode?: ReasonCode | null;
  actionCode?: ModActionCode | null;
  sortOrder?: number;
  isActive?: boolean;
}

export interface ModResponseTemplateFilter {
  reasonCode?: ReasonCode;
  actionCode?: ModActionCode;
}

@Injectable()
export class ModResponseTemplatesService {
  constructor(
    @InjectRepository(ModResponseTemplate)
    private readonly templates: Repository<ModResponseTemplate>,
  ) {}

  /**
   * Moderator read: the active templates that fit the decision in front of
   * them. A filter matches its own code OR NULL ("fits any"), so a general
   * closing note is offered alongside the keyed ones. Ordered by `sortOrder`
   * then `label` so the list an admin arranged is the list a moderator sees.
   */
  async listActive(
    filter: ModResponseTemplateFilter,
  ): Promise<ModResponseTemplateDTO[]> {
    // One `where` array element per accepted combination: TypeORM ORs them,
    // and each element still carries `isActive: true`, so no deactivated row
    // can slip in through a widened branch.
    const reasonMatches =
      filter.reasonCode === undefined
        ? [undefined]
        : [filter.reasonCode, IsNull()];
    const actionMatches =
      filter.actionCode === undefined
        ? [undefined]
        : [filter.actionCode, IsNull()];

    const where = reasonMatches.flatMap((reasonMatch) =>
      actionMatches.map((actionMatch) => ({
        isActive: true,
        ...(reasonMatch === undefined ? {} : { reasonCode: reasonMatch }),
        ...(actionMatch === undefined ? {} : { actionCode: actionMatch }),
      })),
    );

    const rows = await this.templates.find({
      where,
      order: { sortOrder: 'ASC', label: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toModResponseTemplate);
  }

  /** Admin read: every template, active or not, in display order. */
  async listAll(): Promise<ModResponseTemplateAdminDTO[]> {
    const rows = await this.templates.find({
      order: { sortOrder: 'ASC', label: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toModResponseTemplateAdmin);
  }

  async create(
    input: ModResponseTemplateWriteInput,
    authorUserId: string,
  ): Promise<ModResponseTemplateAdminDTO> {
    this.assertPlaceholdersAreKnown(input.body);
    try {
      const saved = await this.templates.save(
        this.templates.create({
          label: input.label.trim(),
          body: input.body.trim(),
          reasonCode: input.reasonCode ?? null,
          actionCode: input.actionCode ?? null,
          sortOrder: input.sortOrder ?? (await this.nextSortOrder()),
          isActive: input.isActive ?? true,
          createdByUserId: authorUserId,
        }),
      );
      return toModResponseTemplateAdmin(saved);
    } catch (error) {
      throw this.asLabelConflict(error);
    }
  }

  async update(
    id: string,
    input: Partial<ModResponseTemplateWriteInput>,
  ): Promise<ModResponseTemplateAdminDTO> {
    const template = await this.templates.findOne({ where: { id } });
    if (!template) throw new NotFoundException('Response template not found');

    if (input.body !== undefined) this.assertPlaceholdersAreKnown(input.body);

    if (input.label !== undefined) template.label = input.label.trim();
    if (input.body !== undefined) template.body = input.body.trim();
    if (input.reasonCode !== undefined)
      template.reasonCode = input.reasonCode ?? null;
    if (input.actionCode !== undefined)
      template.actionCode = input.actionCode ?? null;
    if (input.sortOrder !== undefined) template.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) template.isActive = input.isActive;

    try {
      const saved = await this.templates.save(template);
      return toModResponseTemplateAdmin(saved);
    } catch (error) {
      throw this.asLabelConflict(error);
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.templates.delete({ id });
    if (!result.affected)
      throw new NotFoundException('Response template not found');
  }

  /**
   * Writes `ids`' positions as `sortOrder = index`. Every id must exist, so a
   * stale list (a template deleted in another tab) fails loudly instead of
   * silently reordering a subset.
   */
  async reorder(ids: string[]): Promise<ModResponseTemplateAdminDTO[]> {
    const rows = await this.templates.find({ where: { id: In(ids) } });
    if (rows.length !== ids.length) {
      throw new NotFoundException(
        'One or more response templates no longer exist',
      );
    }
    const positionById = new Map(ids.map((id, index) => [id, index]));
    for (const row of rows) {
      row.sortOrder = positionById.get(row.id) ?? row.sortOrder;
    }
    await this.templates.save(rows);
    return this.listAll();
  }

  /** New templates land at the bottom of the list rather than colliding with
   *  position 0 and reshuffling an order an admin already arranged. */
  private async nextSortOrder(): Promise<number> {
    const last = await this.templates.find({
      order: { sortOrder: 'DESC' },
      take: 1,
    });
    const lastRow = last[0];
    return lastRow ? lastRow.sortOrder + 1 : 0;
  }

  /** Labels are unique so a picker row is identifiable. A collision is a 409
   *  the admin screen can explain, and any other error is rethrown untouched. */
  private asLabelConflict(error: unknown): unknown {
    if (isUniqueViolation(error, 'UQ_mod_response_templates_label')) {
      return new ConflictException(
        'A response template with that label already exists',
      );
    }
    return error;
  }

  /** A `{token}` the frontend cannot resolve would reach a member as a literal
   *  brace, so it is rejected at the write boundary. */
  private assertPlaceholdersAreKnown(body: string): void {
    const unknown = unknownPlaceholders(body);
    if (unknown.length === 0) return;
    throw new BadRequestException(
      `Unknown placeholder(s): ${unknown.map((token) => `{${token}}`).join(', ')}. ` +
        `Allowed: ${TEMPLATE_PLACEHOLDERS.map((token) => `{${token}}`).join(', ')}`,
    );
  }
}
