import { IsOptional, IsString } from 'class-validator';

export class ListGlossaryQuery {
  // Filters `GlossaryTerm.category`. Unlike `/resources`, the glossary list
  // isn't paginated (mirrors the FE's `GlossaryPage`, which renders every
  // matching term at once, grouped by letter, with client-side search).
  @IsOptional() @IsString() category?: string;
}
