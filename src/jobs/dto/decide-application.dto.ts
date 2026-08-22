import { IsIn } from 'class-validator';
import { JobApplicationStatus } from '../entities/job-application.entity';

/**
 * `PATCH /jobs/:slug/applications/:id` body — the poster's decision on one
 * application (BE-HSG-16).
 *
 * `JobApplicationStatus` also carries `Submitted`, which is the state an
 * application STARTS in and can never be moved back to, so the accepted set is
 * spelled out rather than taken from the enum wholesale. Mirrors
 * `VolunteeringService.decideSignup`'s narrowed
 * `SignupStatus.Accepted | SignupStatus.Declined` parameter on the sibling
 * domain.
 */
export class DecideJobApplicationDto {
  @IsIn([
    JobApplicationStatus.Reviewing,
    JobApplicationStatus.Accepted,
    JobApplicationStatus.Declined,
  ])
  status!:
    | JobApplicationStatus.Reviewing
    | JobApplicationStatus.Accepted
    | JobApplicationStatus.Declined;
}
