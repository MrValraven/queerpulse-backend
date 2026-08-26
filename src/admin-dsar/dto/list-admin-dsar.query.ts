import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { DsarStatus } from '../../account/entities/dsar-request.entity';

export class ListAdminDsarQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // The stored status, which is also exactly what the rows display. There is
  // no resolved/stored split here (unlike `ListAdminInvitesQuery`), because a
  // DSAR's status only ever changes when an operator moves it.
  @IsOptional()
  @IsEnum(DsarStatus)
  status?: DsarStatus;
}
