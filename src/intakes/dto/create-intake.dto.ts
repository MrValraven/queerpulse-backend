import { IsNotEmptyObject, IsObject } from 'class-validator';
import { IsBoundedPayload } from '../validators/is-bounded-payload.decorator';

/**
 * Body for `POST /intakes/:kind` — a wrapper around a single free-form
 * `payload` object. The global `ValidationPipe`
 * (`whitelist` + `forbidNonWhitelisted`) means only `payload` is accepted at
 * the top level: any other top-level key is rejected outright. `payload` itself
 * is deliberately schema-less (each intake kind sends its own field set) but is
 * bounded on every axis by `@IsBoundedPayload` so this — for the public kinds,
 * unauthenticated — endpoint can't be used to persist unbounded or deeply
 * nested junk. `whitelist` does NOT strip the inside of `payload` (it has no
 * nested DTO type), so the form's fields survive intact.
 */
export class CreateIntakeDto {
  @IsObject()
  @IsNotEmptyObject()
  @IsBoundedPayload()
  payload!: Record<string, unknown>;
}
