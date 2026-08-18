import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { WriterApplicationStatus } from '../entities/magazine-writer-application.entity';

export class ListAdminWriterApplicationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsEnum(WriterApplicationStatus)
  status?: WriterApplicationStatus;
}
