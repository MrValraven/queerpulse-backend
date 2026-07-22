import { IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /flatmate-profiles/:slug/hello body. Optional — when empty, the service
 * sends a default greeting. */
export class SayHelloDto {
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
}
