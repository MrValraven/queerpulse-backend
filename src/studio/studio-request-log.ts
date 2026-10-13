/**
 * Studio records nothing about what a member listens to, and the request log
 * would otherwise name each streamed track. The logger skips every request
 * whose path is a track page or its stream.
 */
export function isStudioTrackRequest(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const [path = ''] = url.split('?');
  return (
    /(?:^|\/)studio\/tracks\/[^/]+(?:\/|$)/i.test(path) &&
    !path.toLowerCase().includes('/admin/studio/')
  );
}
