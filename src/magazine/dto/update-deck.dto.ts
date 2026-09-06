import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsISO8601, IsOptional, ValidateIf } from 'class-validator';
import { CreateDeckDto } from './create-deck.dto';

/**
 * `PATCH /magazine/admin/decks/:id`. Every creation field is patchable, plus
 * the two publish controls, which the service reads to derive
 * `MagazineDeck.publishedAt` rather than mapping either onto an entity column
 * directly.
 *
 * `publishedAt` is the richer of the two and mirrors `PublishArticleDto`'s
 * null-widening idiom exactly (`ValidateIf` skips `@IsISO8601()` for an
 * explicit `null`): an ISO instant publishes at that moment, and a FUTURE
 * instant therefore schedules the deck for free, because the public read
 * paths (`MagazineService.listDecks`/`getDeckBySlug`) already gate on
 * `published_at <= now`. `null` pulls the deck back to draft.
 *
 * `published` is the original boolean toggle and stays supported: `true`
 * publishes now (keeping an existing first-publish date), `false`
 * unpublishes. When both are sent, `publishedAt` wins, since it is the field
 * that can express something the boolean cannot.
 */
export class UpdateDeckDto extends PartialType(CreateDeckDto) {
  @IsOptional() @IsBoolean() published?: boolean;

  @IsOptional()
  @ValidateIf((updateDeck: UpdateDeckDto) => updateDeck.publishedAt !== null)
  @IsISO8601()
  publishedAt?: string | null;
}
