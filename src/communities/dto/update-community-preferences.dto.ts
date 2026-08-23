import { IsEnum } from 'class-validator';
import { CommunityNotificationLevel } from '../entities/community-member.entity';

/**
 * Body of `PATCH /communities/:slug/preferences`.
 *
 * `notificationLevel` is the only field, and it is REQUIRED: a PATCH with an
 * empty body would be a silent no-op under the global `whitelist` +
 * `forbidNonWhitelisted` pipe, and there is nothing else about a membership a
 * member may set from here. Notably absent is any way to name a member: the
 * caller can only ever change their own row, which the service enforces from
 * the session rather than from anything in this body.
 */
export class UpdateCommunityPreferencesDto {
  @IsEnum(CommunityNotificationLevel)
  notificationLevel!: CommunityNotificationLevel;
}
