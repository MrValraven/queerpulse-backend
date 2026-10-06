import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateThreadDto } from './create-thread.dto';
import { EndFundingAskDto } from './end-funding-ask.dto';
import { FundingLookupQuery } from './funding-lookup.query';
import { ListThreadsQuery } from './list-threads.query';
import { UpdateThreadDto } from './update-thread.dto';

const callFunding = {
  linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
  funderName: 'Fundação Gulbenkian',
  amountMin: null,
  amountMax: 5000,
  deadline: '2026-12-01T23:59:00.000Z',
  eligibility: ['individuals', 'collectives'],
  scope: 'national',
};

async function constraintMessagesOf(
  instance: object,
  property: string,
): Promise<string[]> {
  const errors = await validate(instance, { forbidUnknownValues: true });
  const fundingError = errors.find((error) => error.property === 'funding');
  const child = fundingError?.children?.find(
    (candidate) => candidate.property === property,
  );
  return Object.values(child?.constraints ?? {});
}

async function errorPropertiesOf(instance: object): Promise<string[]> {
  const errors = await validate(instance, { forbidUnknownValues: true });
  return errors.flatMap((error) => [
    error.property,
    ...(error.children ?? []).map(
      (child) => `${error.property}.${child.property}`,
    ),
  ]);
}

describe('CreateThreadDto funding', () => {
  it('accepts an open call with its nested funding object', async () => {
    const dto = plainToInstance(CreateThreadDto, {
      title: 'Arts grant',
      body: 'Applications close in December',
      category: 'funding',
      kind: 'call',
      funding: callFunding,
    });
    expect(await errorPropertiesOf(dto)).toEqual([]);
  });

  it('refuses an unknown eligibility inside the funding object', async () => {
    const dto = plainToInstance(CreateThreadDto, {
      title: 'Arts grant',
      body: 'Applications close in December',
      category: 'funding',
      kind: 'call',
      funding: { ...callFunding, eligibility: ['everyone'] },
    });
    expect(await errorPropertiesOf(dto)).toContain('funding.eligibility');
  });

  it('refuses cents in an amount', async () => {
    const dto = plainToInstance(CreateThreadDto, {
      title: 'Arts grant',
      body: 'Applications close in December',
      category: 'funding',
      kind: 'call',
      funding: { ...callFunding, amountMax: 99.5 },
    });
    expect(await errorPropertiesOf(dto)).toContain('funding.amountMax');
  });

  it.each([
    ['an offset-less deadline', { deadline: '2026-12-01T23:59' }],
    ['a date-only deadline', { deadline: '2026-12-01' }],
  ])('refuses %s', async (_label, override) => {
    const dto = plainToInstance(CreateThreadDto, {
      title: 'Arts grant',
      body: 'Applications close in December',
      category: 'funding',
      kind: 'call',
      funding: { ...callFunding, ...override },
    });
    expect(await errorPropertiesOf(dto)).toContain('funding.deadline');
  });

  it.each([
    ['next friday', 'deadline must be a date and time like'],
    ['2026-12-01T23:59', 'deadline needs a time zone, like'],
    ['2026-12-01', 'deadline must be a date and time like'],
    ['2026-02-30T10:00:00Z', 'deadline must be a date and time like'],
  ])(
    'gives one message starting with the property for %s',
    async (deadline, start) => {
      const dto = plainToInstance(CreateThreadDto, {
        title: 'Arts grant',
        body: 'Applications close in December',
        category: 'funding',
        kind: 'call',
        funding: { ...callFunding, deadline },
      });
      const messages = await constraintMessagesOf(dto, 'deadline');
      expect(messages).toHaveLength(1);
      const firstMessage = messages[0] ?? '';
      expect(firstMessage.startsWith(start)).toBe(true);
    },
  );

  it('accepts a deadline with a +01:00 offset', async () => {
    const dto = plainToInstance(CreateThreadDto, {
      title: 'Arts grant',
      body: 'Applications close in December',
      category: 'funding',
      kind: 'call',
      funding: { ...callFunding, deadline: '2026-12-02T00:59:00+01:00' },
    });
    expect(await errorPropertiesOf(dto)).toEqual([]);
  });

  it('accepts a fundraiser with its nested funding object', async () => {
    const dto = plainToInstance(CreateThreadDto, {
      title: 'Help with surgery costs',
      body: 'Everything is explained on the GoFundMe page.',
      category: 'funding',
      kind: 'ask',
      funding: {
        linkUrl: 'https://www.gofundme.com/f/help-ana',
        goalAmount: 1200,
        askPurpose: 'healthcare',
        beneficiary: 'self',
      },
    });
    expect(await errorPropertiesOf(dto)).toEqual([]);
  });

  it('refuses an unknown ask purpose', async () => {
    const dto = plainToInstance(CreateThreadDto, {
      title: 'Help with surgery costs',
      body: 'Details below',
      category: 'funding',
      kind: 'ask',
      funding: {
        linkUrl: 'https://www.gofundme.com/f/help-ana',
        goalAmount: 1200,
        askPurpose: 'holiday',
        beneficiary: 'self',
      },
    });
    expect(await errorPropertiesOf(dto)).toContain('funding.askPurpose');
  });
});

describe('UpdateThreadDto funding', () => {
  it('accepts a full replacement funding object on its own', async () => {
    const dto = plainToInstance(UpdateThreadDto, { funding: callFunding });
    expect(await errorPropertiesOf(dto)).toEqual([]);
  });
});

describe('ListThreadsQuery funding filters', () => {
  it('turns a single eligibility into a list', async () => {
    const query = plainToInstance(ListThreadsQuery, {
      category: 'funding',
      fundingView: 'open',
      eligibility: 'students',
      scope: 'eu',
    });
    expect(await errorPropertiesOf(query)).toEqual([]);
    expect(query.eligibility).toEqual(['students']);
  });

  it('keeps a repeated eligibility as a list', async () => {
    const query = plainToInstance(ListThreadsQuery, {
      eligibility: ['students', 'collectives'],
    });
    expect(await errorPropertiesOf(query)).toEqual([]);
    expect(query.eligibility).toEqual(['students', 'collectives']);
  });

  it.each([
    ['fundingView', { fundingView: 'archive' }],
    ['eligibility', { eligibility: ['everyone'] }],
    ['scope', { scope: 'galactic' }],
  ])('refuses an unknown %s', async (property, raw) => {
    const query = plainToInstance(ListThreadsQuery, raw);
    expect(await errorPropertiesOf(query)).toContain(property);
  });
});

describe('FundingLookupQuery', () => {
  it('requires a link', async () => {
    expect(
      await errorPropertiesOf(plainToInstance(FundingLookupQuery, {})),
    ).toContain('link');
  });

  it('accepts a link of any shape and leaves parsing to the service', async () => {
    expect(
      await errorPropertiesOf(
        plainToInstance(FundingLookupQuery, { link: 'gofundme.com/f/x' }),
      ),
    ).toEqual([]);
  });
});

describe('EndFundingAskDto', () => {
  it.each(['goal_reached', 'closed'])('accepts %s', async (reason) => {
    expect(
      await errorPropertiesOf(plainToInstance(EndFundingAskDto, { reason })),
    ).toEqual([]);
  });

  it('refuses any other reason', async () => {
    expect(
      await errorPropertiesOf(
        plainToInstance(EndFundingAskDto, { reason: 'paused' }),
      ),
    ).toContain('reason');
  });
});
