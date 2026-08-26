import type { ReasonCode } from '../reports/reason-catalogue';
import type { ModActionCode } from '../moderation/dto/mod-action.dto';
import { ModResponseTemplate } from './entities/mod-response-template.entity';

/**
 * There is no global serializer in this codebase, so entities are hand-mapped
 * here or their columns leak. The moderator-facing shape deliberately omits
 * `createdByUserId`, `createdAt` and `updatedAt`: which staff member wrote a
 * canned note is operating-team metadata, and the picker has no use for it.
 */
export interface ModResponseTemplateDTO {
  id: string;
  label: string;
  body: string;
  reasonCode: ReasonCode | null;
  actionCode: ModActionCode | null;
}

/** Admin view adds the ordering, activation and provenance the picker hides. */
export interface ModResponseTemplateAdminDTO extends ModResponseTemplateDTO {
  sortOrder: number;
  isActive: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toModResponseTemplate(
  template: ModResponseTemplate,
): ModResponseTemplateDTO {
  return {
    id: template.id,
    label: template.label,
    body: template.body,
    reasonCode: template.reasonCode,
    actionCode: template.actionCode,
  };
}

export function toModResponseTemplateAdmin(
  template: ModResponseTemplate,
): ModResponseTemplateAdminDTO {
  return {
    ...toModResponseTemplate(template),
    sortOrder: template.sortOrder,
    isActive: template.isActive,
    createdByUserId: template.createdByUserId,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}
