import { IsUUID } from 'class-validator';

// `GET /mod/reports/audit?reportId=` query.
export class AuditLogQuery {
  @IsUUID()
  reportId: string;
}
