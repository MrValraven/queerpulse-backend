import { PartialType } from '@nestjs/mapped-types';
import { CreateJobDto } from './create-job.dto';

// `companySlug`/`company`/`agreement` are inherited (optional) so a stray
// value in the payload doesn't trip `forbidNonWhitelisted`, but
// `JobsService.update`'s `UpdateJobInput` type omits `companySlug`/`company`
// entirely and never reads them — a job's company/poster affiliation is
// fixed at creation (mirrors `UpdateCompanyDto`'s identical "handle/team
// ignored on patch" precedent).
export class UpdateJobDto extends PartialType(CreateJobDto) {}
