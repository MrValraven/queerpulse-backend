import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  AssignLeadStaffDto,
  CreateLeadDto,
  LeadNoteDto,
  LeadPersonaSearchQuery,
  LeadStaffSearchQuery,
  ListLeadsQuery,
  UpdateLeadDto,
} from './leads.dto';

const LEAD_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';
const USER_ID = 'cf5a6b7c-8d9e-4f0a-9b1c-4d5e6f7a8b9c';

/** Runs a plain value through the same transform and validation the global
 *  `ValidationPipe` applies, and answers the instance with its errors. */
async function validated<Dto extends object>(
  dtoClass: new () => Dto,
  plain: Record<string, unknown>,
) {
  const instance = plainToInstance(
    dtoClass,
    plain,
    VALIDATION_PIPE_OPTIONS.transformOptions,
  );
  const errors = await validate(instance, VALIDATION_PIPE_OPTIONS);
  return { instance, errors };
}

describe('lead DTOs', () => {
  it('lets every create value through so the service answers its code', async () => {
    const plain = {
      name: 5,
      type: [],
      stage: null,
      location: 7,
      email: {},
      phone: 1,
      links: 'x',
      followUpOn: 3,
      note: 5,
    };
    const { instance, errors } = await validated(CreateLeadDto, plain);
    expect(errors).toHaveLength(0);
    expect({ ...instance }).toEqual(plain);
  });

  it('lets every update value through', async () => {
    const plain = {
      name: 5,
      type: [],
      stage: null,
      location: 7,
      email: {},
      phone: 1,
      links: 'x',
      followUpOn: 3,
      linkedSubprofileId: 5,
    };
    const { instance, errors } = await validated(UpdateLeadDto, plain);
    expect(errors).toHaveLength(0);
    expect({ ...instance }).toEqual(plain);
  });

  it('lets repeated query values through', async () => {
    const plain = { q: ['a', 'b'], stage: ['x'], due: 'TRUE', cursor: ['c'] };
    const { instance, errors } = await validated(ListLeadsQuery, plain);
    expect(errors).toHaveLength(0);
    expect({ ...instance }).toEqual(plain);
    const search = await validated(LeadPersonaSearchQuery, { q: ['a', 'b'] });
    expect(search.errors).toHaveLength(0);
  });

  it('lets any note body through', async () => {
    for (const body of [5, null, ['a'], '']) {
      const { instance, errors } = await validated(LeadNoteDto, { body });
      expect(errors).toHaveLength(0);
      expect({ ...instance }).toEqual({ body });
    }
  });

  it('still refuses an undeclared property', async () => {
    const create = await validated(CreateLeadDto, {
      name: 'Ana',
      linkedSubprofileId: LEAD_ID,
    });
    expect(create.errors).toHaveLength(1);
    expect(create.errors[0]?.property).toBe('linkedSubprofileId');
    const note = await validated(LeadNoteDto, { body: 'a', extra: 1 });
    expect(note.errors).toHaveLength(1);
    expect(note.errors[0]?.property).toBe('extra');
  });

  it('lets every assignedTo value through', async () => {
    const plain = { assignedTo: ['me', 'x'] };
    const { instance, errors } = await validated(ListLeadsQuery, plain);
    expect(errors).toHaveLength(0);
    expect({ ...instance }).toEqual(plain);
  });

  it('lets every staff search and assign value through', async () => {
    const search = await validated(LeadStaffSearchQuery, { q: ['a', 'b'] });
    expect(search.errors).toHaveLength(0);
    expect({ ...search.instance }).toEqual({ q: ['a', 'b'] });
    for (const userId of [5, null]) {
      const { instance, errors } = await validated(AssignLeadStaffDto, {
        userId,
      });
      expect(errors).toHaveLength(0);
      expect({ ...instance }).toEqual({ userId });
    }
  });

  it('still refuses an undeclared property on the assign body', async () => {
    const assign = await validated(AssignLeadStaffDto, {
      userId: USER_ID,
      leadId: LEAD_ID,
    });
    expect(assign.errors).toHaveLength(1);
    expect(assign.errors[0]?.property).toBe('leadId');
  });
});
