import { IsUUID } from 'class-validator';

/**
 * `POST /conversations/:id/claim/take-over` body (Task 19). `fromUserId` is
 * the claimant the member saw and confirmed taking the thread from. The
 * take-over is guarded on that exact claimant, so it only ever takes the
 * thread from the person the member was shown.
 */
export class TakeOverClaimDto {
  @IsUUID()
  fromUserId!: string;
}
