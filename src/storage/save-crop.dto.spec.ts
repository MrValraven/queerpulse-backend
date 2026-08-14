import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveCropDto } from './dto/save-crop.dto';

function errorsFor(payload: unknown): string[] {
  const dto = plainToInstance(SaveCropDto, payload);
  return validateSync(dto, { whitelist: true }).flatMap((error) =>
    Object.keys(error.constraints ?? {}).concat(
      (error.children ?? []).flatMap((child) =>
        Object.keys(child.constraints ?? {}),
      ),
    ),
  );
}

describe('SaveCropDto', () => {
  it('accepts a valid normalized crop', () => {
    expect(
      errorsFor({
        key: 'avatars/owner-1/pic.jpg',
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5, aspect: '1:1' },
      }),
    ).toEqual([]);
  });

  it('rejects out-of-range fractions', () => {
    expect(
      errorsFor({
        key: 'avatars/owner-1/pic.jpg',
        crop: { x: -1, y: 0, width: 2, height: 0.5, aspect: '1:1' },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a missing key', () => {
    expect(
      errorsFor({
        crop: { x: 0, y: 0, width: 1, height: 1, aspect: 'free' },
      }).length,
    ).toBeGreaterThan(0);
  });
});
