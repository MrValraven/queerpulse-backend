import { OmitType } from '@nestjs/swagger';
import { CreateReportDto } from '../../reports/dto/create-report.dto';

/**
 * Body of `POST /conversations/:id/members/:memberKey/report` (PRD-423): the
 * member report `POST /reports` takes, with the same validation, minus the
 * subject (the route resolves it from the matched chat's member key, always
 * as a `member` subject) and the signed-out contact address (the route is
 * members only). Mirrors Go together's `GroupMemberReportDto`.
 */
export class MatchedChatMemberReportDto extends OmitType(CreateReportDto, [
  'subjectType',
  'subjectId',
  'contactEmail',
] as const) {}
