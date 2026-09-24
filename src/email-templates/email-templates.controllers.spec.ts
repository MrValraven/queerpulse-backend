import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminEmailTemplatesController } from './admin-email-templates.controller';
import { EmailTemplatesController } from './email-templates.controller';

describe('email template controllers', () => {
  it('keeps authoring admin-only', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AdminEmailTemplatesController,
    ) as UserRole[];
    expect(roles).toEqual([UserRole.Admin]);
  });

  it('lets moderators and admins read', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      EmailTemplatesController,
    ) as UserRole[];
    expect(roles).toEqual([UserRole.Moderator, UserRole.Admin]);
  });
});
