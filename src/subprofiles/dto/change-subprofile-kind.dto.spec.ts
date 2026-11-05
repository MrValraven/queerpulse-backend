import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangeSubprofileKindDTO } from './change-subprofile-kind.dto';

describe('ChangeSubprofileKindDTO', () => {
  it('accepts dj', async () => {
    const dto = plainToInstance(ChangeSubprofileKindDTO, { kind: 'dj' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an unknown kind', async () => {
    const dto = plainToInstance(ChangeSubprofileKindDTO, { kind: 'wizard' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });

  it('rejects a missing kind', async () => {
    const dto = plainToInstance(ChangeSubprofileKindDTO, {});
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
