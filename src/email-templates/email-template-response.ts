import type { EmailTemplateLocales } from './email-template-content';
import type { EmailTemplatePurpose } from './email-template-purposes';
import { EmailTemplate } from './entities/email-template.entity';

/** No global serializer here, so the entity is mapped by hand. The moderator
 *  shape leaves out ordering and provenance, which the copy action never uses. */
export interface EmailTemplateDTO {
  id: string;
  label: string;
  purpose: EmailTemplatePurpose;
  locales: EmailTemplateLocales;
}

export interface EmailTemplateAdminDTO extends EmailTemplateDTO {
  sortOrder: number;
  isActive: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toEmailTemplate(template: EmailTemplate): EmailTemplateDTO {
  return {
    id: template.id,
    label: template.label,
    purpose: template.purpose,
    locales: template.locales,
  };
}

export function toEmailTemplateAdmin(
  template: EmailTemplate,
): EmailTemplateAdminDTO {
  return {
    ...toEmailTemplate(template),
    sortOrder: template.sortOrder,
    isActive: template.isActive,
    createdByUserId: template.createdByUserId,
    updatedByUserId: template.updatedByUserId,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}
