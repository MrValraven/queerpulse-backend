import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  AssignCulturalTaskDto,
  CreateCulturalGuideDto,
  CreateCulturalIdeaDto,
  CreateCulturalTaskBatchDto,
  CreateCulturalTaskDto,
  CulturalCommentDto,
  CulturalStaffSearchQuery,
  ListCulturalTasksQuery,
  ReplaceCulturalGuideDto,
  UpdateCulturalIdeaDto,
  UpdateCulturalTaskDto,
} from './cultural-production.dto';

/** Each class of contract 7.1 with its fields, in contract order. */
const DTO_FIELDS: [new () => object, string[]][] = [
  [CulturalStaffSearchQuery, ['q']],
  [CreateCulturalIdeaDto, ['title', 'description', 'eventType', 'status']],
  [UpdateCulturalIdeaDto, ['title', 'description', 'eventType', 'status']],
  [CulturalCommentDto, ['body']],
  [ListCulturalTasksQuery, ['assignedTo', 'status']],
  [
    CreateCulturalTaskDto,
    ['title', 'notes', 'status', 'dueOn', 'ideaId', 'guideId', 'assigneeIds'],
  ],
  [
    UpdateCulturalTaskDto,
    ['title', 'notes', 'status', 'dueOn', 'ideaId', 'guideId'],
  ],
  [AssignCulturalTaskDto, ['userId']],
  [
    CreateCulturalGuideDto,
    ['title', 'eventType', 'locale', 'summary', 'sections'],
  ],
  [
    ReplaceCulturalGuideDto,
    ['revision', 'title', 'eventType', 'locale', 'summary', 'sections'],
  ],
  [CreateCulturalTaskBatchDto, ['eventOn', 'assigneeIds']],
];

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

/** Values no rule of the services accepts, one per field. */
function hostileValuesFor(fields: string[]): Record<string, unknown> {
  const hostileValues: unknown[] = [5, null, ['a', 'b'], {}, '', true, -1];
  return Object.fromEntries(
    fields.map((field, fieldIndex) => [
      field,
      hostileValues[fieldIndex % hostileValues.length],
    ]),
  );
}

describe('cultural production DTOs', () => {
  it('declares the eleven classes of the contract', () => {
    expect(DTO_FIELDS).toHaveLength(11);
  });

  it.each(DTO_FIELDS)(
    '%p decorates every field with @Allow() and nothing else',
    (dtoClass, fields) => {
      const metadata = getMetadataStorage().getTargetValidationMetadatas(
        dtoClass,
        '',
        true,
        false,
      );
      const decoratedFields = [
        ...new Set(metadata.map((rule) => rule.propertyName)),
      ];
      expect(decoratedFields.sort()).toEqual([...fields].sort());
      for (const rule of metadata) {
        expect(rule.type).toBe('whitelistValidation');
      }
    },
  );

  it.each(DTO_FIELDS)(
    '%p lets every field value through so the service answers its code',
    async (dtoClass, fields) => {
      const plain = hostileValuesFor(fields);
      const { instance, errors } = await validated(dtoClass, plain);
      expect(errors).toHaveLength(0);
      expect({ ...instance }).toEqual(plain);
    },
  );

  it.each(DTO_FIELDS)(
    '%p still refuses an undeclared property',
    async (dtoClass, fields) => {
      const plain = { ...hostileValuesFor(fields), undeclaredField: 1 };
      const { errors } = await validated(dtoClass, plain);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe('undeclaredField');
    },
  );

  it('keeps assignees off the task update body', async () => {
    const { errors } = await validated(UpdateCulturalTaskDto, {
      assigneeIds: [],
    });
    expect(errors[0]?.property).toBe('assigneeIds');
  });
});
