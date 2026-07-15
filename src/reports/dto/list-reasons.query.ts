import { IsEnum } from 'class-validator';
import { ReportSubjectType } from '../entities/report.entity';

// `GET /reports/reasons?subjectType=` query.
export class ListReasonsQuery {
  @IsEnum(ReportSubjectType)
  subjectType: ReportSubjectType;
}
