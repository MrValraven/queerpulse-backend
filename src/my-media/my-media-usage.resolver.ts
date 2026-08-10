export const MY_MEDIA_USAGE_RESOLVER = 'MY_MEDIA_USAGE_RESOLVER';

export interface MyMediaUsageResolver {
  /** Maps each in-use key -> a short human label; absent keys are not in use. */
  resolve(userId: string, keys: string[]): Promise<Map<string, string>>;
}
