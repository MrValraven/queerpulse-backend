import { ValidationPipeOptions } from '@nestjs/common';

/**
 * Options for the global `ValidationPipe`, extracted so the exact production
 * transform behaviour can be asserted in a unit test (see
 * `profiles.service.spec.ts`) rather than being trapped inline in `main.ts`.
 *
 * `exposeUnsetFields: false` is load-bearing, not cosmetic. With ES2022+
 * class-field semantics every declared DTO property becomes an own value
 * (`undefined`) even when the request omits it; class-transformer's default
 * (`exposeUnsetFields: true`) then keeps those omitted fields as enumerable
 * `undefined` keys on the validated instance. A partial-update DTO fed through
 * `Object.assign(entity, dto)` therefore CLOBBERS hydrated columns with
 * `undefined` — the onboarding "intents" step, sending only `lookingFor`, wiped
 * `profile.tags` in memory and crashed `ProfilesService.loadRelated` on
 * `tags.length`. Not exposing unset fields makes "omitted" mean "leave alone".
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { exposeUnsetFields: false },
};
