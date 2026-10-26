import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsUUID,
} from 'class-validator';

/** Caps one bulk invite call's batch size. `AdminInvitesService.bulk` runs the
 * single-invite revoke or refresh once per id, each in its own transaction, so
 * this bounds the request's worst-case work. */
export const ADMIN_INVITE_BULK_CAP = 100;

export const ADMIN_INVITE_BULK_ACTIONS = ['refresh', 'revoke'] as const;
export type AdminInviteBulkAction = (typeof ADMIN_INVITE_BULK_ACTIONS)[number];

/**
 * `POST /admin/invites/bulk` body: applies one action (refresh or revoke) to
 * many invites in a single call, addressed by the internal ids the admin list
 * returns. Each id follows exactly the rules of its single route, and an id
 * that does not qualify lands in `skipped` with its reason while the rest go
 * ahead.
 */
export class BulkAdminInvitesDto {
  @IsIn(ADMIN_INVITE_BULK_ACTIONS)
  action!: AdminInviteBulkAction;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ADMIN_INVITE_BULK_CAP)
  // Case-insensitive, so two spellings of one uuid are a 400. Any uuid version
  // passes, matching `ParseUUIDPipe` on the single routes.
  @ArrayUnique((id: unknown) =>
    typeof id === 'string' ? id.toLowerCase() : id,
  )
  @IsUUID('all', { each: true })
  ids!: string[];
}
