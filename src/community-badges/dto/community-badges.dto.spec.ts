import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  CreateCommunityBadgeDto,
  ListMyCommunityGiftsQuery,
  SendCommunityGiftDto,
  SetCommunityFlairDto,
  UpdateCommunityBadgeDto,
  UpdateCommunityGiftDto,
} from './community-badges.dto';

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

describe('community badge DTOs', () => {
  it('keeps every declared field through the whitelist', async () => {
    const { errors, instance } = await validated(CreateCommunityBadgeDto, {
      name: 1,
      iconKey: 2,
      tint: 3,
      ruleType: 4,
      threshold: 'x',
      isEnabled: 'y',
    });
    expect(errors).toEqual([]);
    expect(instance.threshold).toBe('x');
    expect(instance.isEnabled).toBe('y');
  });

  it('still refuses an undeclared property', async () => {
    expect(
      (
        await validated(SendCommunityGiftDto, {
          recipientSlug: 'mara',
          amount: 5,
        })
      ).errors.map((error) => error.property),
    ).toEqual(['amount']);
  });

  it('declares ruleType on an update so the service answers badge_rule_locked', async () => {
    const { errors, instance } = await validated(UpdateCommunityBadgeDto, {
      ruleType: 'tenure_days',
      threshold: 40,
    });
    expect(errors).toEqual([]);
    expect(instance.ruleType).toBe('tenure_days');
  });

  it('lets a null flair badge id through', async () => {
    const { errors, instance } = await validated(SetCommunityFlairDto, {
      badgeId: null,
    });
    expect(errors).toEqual([]);
    expect(instance.badgeId).toBeNull();
  });

  it('lets every gift value through so the service answers its code', async () => {
    const { errors, instance } = await validated(SendCommunityGiftDto, {
      recipientSlug: 7,
      giftKey: [],
      note: { text: 'hi' },
    });
    expect(errors).toEqual([]);
    expect(instance.note).toEqual({ text: 'hi' });
  });

  it('lets a non boolean hidden flag through', async () => {
    const { errors, instance } = await validated(UpdateCommunityGiftDto, {
      isHidden: 'true',
    });
    expect(errors).toEqual([]);
    expect(instance.isHidden).toBe('true');
  });

  it('keeps the page of the shelf query and refuses another key', async () => {
    expect(
      (await validated(ListMyCommunityGiftsQuery, { page: '2' })).errors,
    ).toEqual([]);
    expect(
      (
        await validated(ListMyCommunityGiftsQuery, { page: '2', size: '5' })
      ).errors.map((error) => error.property),
    ).toEqual(['size']);
  });
});
