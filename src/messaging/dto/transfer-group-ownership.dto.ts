import { IsUUID } from 'class-validator';

/**
 * `POST /conversations/:id/owner` body (DES-228). `userId` is the target's
 * user id, an active member of the group who becomes its new `owner`; the
 * caller (the CURRENT owner) becomes `admin` in the same transaction. OWNER
 * ONLY (the service re-checks the caller's role).
 */
export class TransferGroupOwnershipDto {
  @IsUUID()
  userId!: string;
}
