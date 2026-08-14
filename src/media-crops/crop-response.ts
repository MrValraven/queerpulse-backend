import type { CropRect } from './crop-rect';
import { toBareKey } from '../storage/bare-key';

/** Look up a crop for a stored key from a pre-loaded map (batched by the caller). */
export function cropFor(
  storageKey: string | null | undefined,
  crops: Map<string, CropRect>,
): CropRect | undefined {
  if (!storageKey) return undefined;
  return crops.get(toBareKey(storageKey));
}
