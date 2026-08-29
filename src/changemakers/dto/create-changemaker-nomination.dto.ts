import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateChangemakerNominationDto {
  @IsString() @MinLength(1) @MaxLength(200) nomineeName!: string;

  // COM-16: the form's copy promises "a name and a sentence is enough to
  // start" (`community:changemakers.nominate.lead`) — required so that
  // promise is actually true, and so admin triage (COM-17) has something to
  // read besides a bare name.
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;

  // COM-18: the nominee's profile `slug` when the nominator picked them out of
  // the member search — the repo convention for addressing a member from the
  // client (see `InviteCollaboratorDTO`), resolved to a `userId` server-side in
  // `ChangemakerNominationsService.create()`. Never a raw `users.id` UUID.
  // Optional: most nominees are not members, which is the point of the form.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nomineeSlug?: string;

  // COM-18: free-text "where else can we find them" for a nominee who is not
  // a member — a handle, a link, an email. Optional, and deliberately
  // unvalidated beyond a length cap: a reviewer is better served by whatever
  // the nominator actually knows than by a format the platform invented.
  @IsOptional() @IsString() @MaxLength(200) nomineeContact?: string;
}
