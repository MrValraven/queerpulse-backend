import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UnpublishPieceDto } from './unpublish-piece.dto';

/**
 * The body is optional so an empty POST keeps taking a published piece to
 * `ready`; a `stage` has to be one of the two places an editor can send it.
 */
describe('UnpublishPieceDto', () => {
  const propertiesWithErrors = async (
    payload: Record<string, unknown>,
  ): Promise<string[]> => {
    const errors = await validate(plainToInstance(UnpublishPieceDto, payload));
    return errors.map((error) => error.property);
  };

  it('accepts an empty body', async () => {
    expect(await propertiesWithErrors({})).toEqual([]);
  });

  it('accepts drafting', async () => {
    expect(await propertiesWithErrors({ stage: 'drafting' })).toEqual([]);
  });

  it('accepts in_review', async () => {
    expect(await propertiesWithErrors({ stage: 'in_review' })).toEqual([]);
  });

  it.each(['published', 'ready', 'edit', 'DRAFTING', '', 3])(
    'refuses the stage %p',
    async (stage) => {
      expect(await propertiesWithErrors({ stage })).toEqual(['stage']);
    },
  );
});
