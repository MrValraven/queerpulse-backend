import { BadRequestException } from '@nestjs/common';

export const TATTOO_ITEM_INVALID_CODE = 'TATTOO_ITEM_INVALID';
export const CLIENT_CONSENT_REQUIRED_CODE = 'CLIENT_CONSENT_REQUIRED';
export const FLASH_DAY_EVENT_UNLINKED_PERSONA_CODE =
  'FLASH_DAY_EVENT_UNLINKED_PERSONA';
export const FLASH_DAY_EVENT_NOT_ELIGIBLE_CODE = 'FLASH_DAY_EVENT_NOT_ELIGIBLE';
export const TATTOO_SKIN_INVALID_CODE = 'TATTOO_SKIN_INVALID';

export const tattooItemInvalid = (
  itemIndex: number,
  field: string,
): BadRequestException =>
  new BadRequestException({
    code: TATTOO_ITEM_INVALID_CODE,
    message: `Item ${itemIndex} has an invalid ${field}.`,
    itemIndex,
    field,
  });

export const clientConsentRequired = (itemIndex: number): BadRequestException =>
  new BadRequestException({
    code: CLIENT_CONSENT_REQUIRED_CODE,
    message:
      'Confirm that your client agreed to this photo being shared on QueerPulse.',
    itemIndex,
  });

export const flashDayEventUnlinkedPersona = (
  itemIndex: number,
): BadRequestException =>
  new BadRequestException({
    code: FLASH_DAY_EVENT_UNLINKED_PERSONA_CODE,
    message:
      'Link this persona to your profile before you link a flash day to an event.',
    itemIndex,
  });

export const flashDayEventNotEligible = (
  itemIndex: number,
): BadRequestException =>
  new BadRequestException({
    code: FLASH_DAY_EVENT_NOT_ELIGIBLE_CODE,
    message:
      'Pick a published public event that you or a co-owner host, co-host or play.',
    itemIndex,
  });

export const tattooSkinInvalid = (path: string): BadRequestException =>
  new BadRequestException({
    code: TATTOO_SKIN_INVALID_CODE,
    message: `skinData.${path} is invalid.`,
    path,
  });
