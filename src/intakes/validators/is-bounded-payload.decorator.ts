import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Hard ceilings for an intake `payload`. This is an unauthenticated write
 * surface for the public kinds, so the free-form jsonb document must be bounded
 * on every axis a client controls — otherwise a caller could persist megabytes
 * of arbitrarily-nested junk. The DTO already `forbidNonWhitelisted`-rejects any
 * unknown TOP-LEVEL key (only `payload` is allowed); this guards the INSIDE of
 * `payload`, which is intentionally schema-less.
 */
const MAX_SERIALIZED_BYTES = 16_384; // 16 KB of JSON is far more than any form
const MAX_KEYS = 60; // total keys across the whole nested document
const MAX_DEPTH = 5; // forms are flat; a little nesting is tolerated
const MAX_STRING_LENGTH = 8_000; // longest single textarea we accept

interface WalkState {
  keys: number;
}

/**
 * Depth-first check that the value is a plain-object document of primitives,
 * arrays, and nested plain objects only — no functions, no runaway nesting,
 * no oversized strings, and no more than {@link MAX_KEYS} keys in total.
 * Returns false (rather than throwing) so class-validator reports it as a
 * normal validation failure → 400.
 */
function isBounded(value: unknown, depth: number, state: WalkState): boolean {
  if (depth > MAX_DEPTH) {
    return false;
  }
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case 'string':
      return value.length <= MAX_STRING_LENGTH;
    case 'number':
      return Number.isFinite(value);
    case 'boolean':
      return true;
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint — never valid jsonb content.
      return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isBounded(item, depth + 1, state));
  }
  // Reject exotic objects (Date, Map, class instances) — only plain objects.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  for (const [, nested] of Object.entries(value as Record<string, unknown>)) {
    state.keys += 1;
    if (state.keys > MAX_KEYS) {
      return false;
    }
    if (!isBounded(nested, depth + 1, state)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates that a value is a bounded, plain-object intake payload: a non-null
 * plain object whose serialized size, key count, nesting depth, and string
 * lengths all sit under the ceilings above. Paired with `@IsObject()` /
 * `@IsNotEmptyObject()` on the field.
 */
export function IsBoundedPayload(validationOptions?: ValidationOptions) {
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isBoundedPayload',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          const prototype: unknown =
            value === null || typeof value !== 'object'
              ? undefined
              : Object.getPrototypeOf(value);
          if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            (prototype !== Object.prototype && prototype !== null)
          ) {
            return false;
          }
          // Cheap size gate first, before the structural walk.
          let serialized: string;
          try {
            serialized = JSON.stringify(value);
          } catch {
            // A circular reference can't be persisted as jsonb.
            return false;
          }
          if (
            serialized === undefined ||
            Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES
          ) {
            return false;
          }
          return isBounded(value, 0, { keys: 0 });
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a plain object no larger than ${MAX_SERIALIZED_BYTES} bytes, with at most ${MAX_KEYS} keys, ${MAX_DEPTH} levels deep, and no string longer than ${MAX_STRING_LENGTH} characters`;
        },
      },
    });
  };
}
