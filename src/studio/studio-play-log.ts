/**
 * Describes a failure of the play path for a log line. It names the error
 * class and a string Postgres `code` when present. The message stays out,
 * since a database message can quote a track or member id.
 */
export function describePlayErrorWithoutIds(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name} (code ${code})` : error.name;
}
