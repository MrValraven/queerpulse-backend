/** A crop expressed as fractions (0..1) of the source image, after EXIF orientation. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Frame ratio used, e.g. "1:1", "2:1", or "free". */
  aspect: string;
}

export const IDENTITY_CROP: CropRect = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  aspect: 'free',
};

export function isIdentityCrop(crop: CropRect): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}
