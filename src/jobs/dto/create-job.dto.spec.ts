import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateJobDto } from './create-job.dto';
import { UpdateJobDto } from './update-job.dto';

function baseJob(overrides: Record<string, unknown> = {}) {
  return plainToInstance(CreateJobDto, {
    title: 'Nurse',
    category: 'healthcare',
    commitment: 'fullTime',
    seniority: 'anyLevel',
    format: 'remote',
    location: 'Remote',
    description: 'Night shifts',
    agreement: true,
    ...overrides,
  });
}

async function errorProperties(
  dto: CreateJobDto | UpdateJobDto,
): Promise<string[]> {
  return (await validate(dto)).map((error) => error.property);
}

describe('CreateJobDto work vocabulary', () => {
  it('accepts a job field id with id-valued commitment and seniority', async () => {
    expect(await errorProperties(baseJob())).toEqual([]);
  });

  it('rejects the retired English labels and "Other"', async () => {
    for (const category of [
      'Design & creative',
      'Other',
      'games',
      'adultWork',
      'lifeStage',
    ]) {
      expect(await errorProperties(baseJob({ category }))).toContain(
        'category',
      );
    }
    expect(
      await errorProperties(baseJob({ commitment: 'Full-time' })),
    ).toContain('commitment');
    expect(await errorProperties(baseJob({ seniority: 'Junior' }))).toContain(
      'seniority',
    );
  });

  it('accepts a known profession and rejects an unknown one', async () => {
    expect(
      await errorProperties(baseJob({ profession: 'nurse' })),
    ).not.toContain('profession');
    expect(await errorProperties(baseJob({ profession: 'wizard' }))).toContain(
      'profession',
    );
  });

  it('lets an update clear the profession with null', async () => {
    const update = plainToInstance(UpdateJobDto, { profession: null });
    expect(await errorProperties(update)).not.toContain('profession');
  });
});
