import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Sort keys the admin guide list offers. `reviewDue` is the default and the
 *  reason the list exists: it answers "which guides are stale?", with
 *  never-reviewed guides first. */
export const ADMIN_RESOURCE_SORTS = ['reviewDue', 'title', 'updated'] as const;
export type AdminResourceSort = (typeof ADMIN_RESOURCE_SORTS)[number];

export class ListAdminResourcesQuery {
  @IsOptional() @IsString() @MaxLength(60) category?: string;

  @IsOptional() @IsIn(ADMIN_RESOURCE_SORTS) sort?: AdminResourceSort;
}
