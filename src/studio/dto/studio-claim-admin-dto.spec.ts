import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DecideStudioClaimDto } from './decide-studio-claim.dto';
import { ListAdminStudioClaimsQuery } from './list-admin-studio-claims.query';

async function errorsFor(
  dtoClass: new () => object,
  body: object,
): Promise<string[]> {
  return (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();
}

describe('Studio staff claim bodies', () => {
  it('holds a staff note to 1 to 1000 characters after trimming', async () => {
    expect(
      plainToInstance(DecideStudioClaimDto, { note: ' Licence checks out ' })
        .note,
    ).toBe('Licence checks out');
    expect(await errorsFor(DecideStudioClaimDto, { note: '  ' })).toEqual([
      'note',
    ]);
    expect(
      await errorsFor(DecideStudioClaimDto, { note: 'x'.repeat(1001) }),
    ).toEqual(['note']);
    expect(await errorsFor(DecideStudioClaimDto, {})).toEqual(['note']);
  });

  it('takes any claim status or none, and a cursor', async () => {
    expect(await errorsFor(ListAdminStudioClaimsQuery, {})).toEqual([]);
    expect(
      await errorsFor(ListAdminStudioClaimsQuery, {
        status: 'withdrawn',
        cursor: 'abc',
      }),
    ).toEqual([]);
    expect(
      await errorsFor(ListAdminStudioClaimsQuery, { status: 'open' }),
    ).toEqual(['status']);
    expect(
      await errorsFor(ListAdminStudioClaimsQuery, { cursor: 'x'.repeat(201) }),
    ).toEqual(['cursor']);
  });
});
