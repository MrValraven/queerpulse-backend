import { OmitType } from '@nestjs/swagger';
import { CreateReportDto } from '../../reports/dto/create-report.dto';

/**
 * Body of `POST /go-together/groups/:groupId/members/:memberRef/report`
 * (PRD-421): the member report `POST /reports` takes, with the same
 * validation, minus the subject (the route resolves it from `memberRef`,
 * always as a `member` subject) and the signed-out contact address (the
 * route is members only).
 */
export class GroupMemberReportDto extends OmitType(CreateReportDto, [
  'subjectType',
  'subjectId',
  'contactEmail',
] as const) {}
