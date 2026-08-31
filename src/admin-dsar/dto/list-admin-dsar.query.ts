import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { DsarStatus } from '../../account/entities/dsar-request.entity';

export class ListAdminDsarQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  // The stored status, which is also exactly what the rows display. There is
  // no resolved/stored split here (unlike `ListAdminInvitesQuery`), because a
  // DSAR's status only ever changes when an operator moves it.
  @IsOptional()
  @IsEnum(DsarStatus)
  status?: DsarStatus;
}
