import { IsIn, IsOptional } from 'class-validator';
import { StudioCursorQuery } from './studio-cursor.query';

/** `GET /me/studio-purchases`: no `status` lists every status. */
export class ListMyStudioPurchasesQuery extends StudioCursorQuery {
  @IsOptional()
  @IsIn(['confirmed'])
  status?: 'confirmed';
}
