import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import {
  INTAKE_KINDS,
  INTAKE_STATUSES,
  IntakeKind,
  IntakeStatus,
} from '../intake-kinds';

/** `GET /intakes?kind=&status=&page=` — the admin triage list. */
export class ListIntakesQuery {
  @IsOptional()
  @IsIn(INTAKE_KINDS)
  kind?: IntakeKind;

  @IsOptional()
  @IsIn(INTAKE_STATUSES)
  status?: IntakeStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
