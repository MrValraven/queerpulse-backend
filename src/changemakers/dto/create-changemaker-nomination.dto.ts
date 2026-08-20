import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateChangemakerNominationDto {
  @IsString() @MinLength(1) @MaxLength(200) nomineeName!: string;

  // COM-16: the form's copy promises "a name and a sentence is enough to
  // start" (`community:changemakers.nominate.lead`) — required so that
  // promise is actually true, and so admin triage (COM-17) has something to
  // read besides a bare name.
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
