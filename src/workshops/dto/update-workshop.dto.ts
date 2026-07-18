import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkshopDto } from './create-workshop.dto';

/**
 * Every creation field is patchable — a workshop has no create-only
 * affiliation the way a job has `companySlug`/`company`, so unlike
 * `UpdateJobDto` there is nothing for the service's input type to omit.
 * The host is fixed at creation and is never read from the body.
 */
export class UpdateWorkshopDto extends PartialType(CreateWorkshopDto) {}
