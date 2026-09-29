import { BadRequestException } from '@nestjs/common';

/**
 * Where the admin media console's "All" browse resumes: the public prefix it
 * is walking plus the S3 continuation token inside that prefix (`null` = start
 * of the prefix). The browse walks the public prefixes one by one, so the
 * private message prefixes are never listed at all.
 *
 * On the wire it is one opaque string (base64url JSON) in the same
 * `continuationToken` / `nextContinuationToken` fields the console already
 * round-trips, so the response shape is unchanged.
 */
export interface AdminMediaBrowseCursor {
  prefix: string;
  token: string | null;
}

/** Generous bound on an encoded cursor; S3 tokens are a few hundred chars. */
const MAX_ENCODED_CURSOR_LENGTH = 4096;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeBrowseCursor(cursor: AdminMediaBrowseCursor): string {
  return Buffer.from(
    JSON.stringify({ prefix: cursor.prefix, token: cursor.token }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a cursor minted by `encodeBrowseCursor`, accepting it only when it is
 * well-formed base64url JSON with exactly `prefix` and `token`, and `prefix`
 * is one of `browsablePrefixes`. Anything else is a 400, so a tampered cursor
 * can never steer the walk onto a private prefix.
 */
export function decodeBrowseCursor(
  encoded: string,
  browsablePrefixes: ReadonlySet<string>,
): AdminMediaBrowseCursor {
  const invalid = new BadRequestException('Invalid continuation token');
  if (
    encoded.length > MAX_ENCODED_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(encoded)
  ) {
    throw invalid;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid;
  }
  const fields = parsed as Record<string, unknown>;
  const fieldNames = Object.keys(fields).sort();
  if (fieldNames.length !== 2 || fieldNames.join(',') !== 'prefix,token') {
    throw invalid;
  }
  const prefix = fields.prefix;
  if (typeof prefix !== 'string' || !browsablePrefixes.has(prefix)) {
    throw invalid;
  }
  const rawToken = fields.token;
  let token: string | null;
  if (rawToken === null) {
    token = null;
  } else if (typeof rawToken === 'string' && rawToken !== '') {
    token = rawToken;
  } else {
    throw invalid;
  }
  return { prefix, token };
}
