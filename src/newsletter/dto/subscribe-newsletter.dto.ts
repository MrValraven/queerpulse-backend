import { IsEmail, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/** Body for `POST /newsletter/subscribe`. */
export class SubscribeNewsletterDto {
  // Normalise before validation so casing/whitespace never splits a single
  // address into two rows; the service also lowercases defensively.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
