import { IsIn, IsOptional } from 'class-validator';
import { GUEST_PREVIEW_ROLES, type GuestPreviewRole } from '../event-preview';

/**
 * `?viewAs=` on the event detail and lineup reads: an organiser previewing
 * their own gathering as a guest. See `EventsService.getBySlug`.
 */
export class GuestPreviewQuery {
  @IsOptional()
  @IsIn([...GUEST_PREVIEW_ROLES])
  viewAs?: GuestPreviewRole;
}
