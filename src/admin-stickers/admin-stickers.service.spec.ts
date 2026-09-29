import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { Sticker } from '../stickers/entities/sticker.entity';
import {
  StickerPack,
  StickerPackStatus,
} from '../stickers/entities/sticker-pack.entity';
import {
  AdminStickersService,
  LAST_STICKER_IN_PUBLISHED_PACK_CODE,
} from './admin-stickers.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PACK_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_STICKER_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_STICKER_ID = '44444444-4444-4444-8444-444444444444';
const STORAGE_KEY = `stickers/${ADMIN_ID}/55555555-5555-4555-8555-555555555555.png`;
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function makeSticker(overrides: Partial<Sticker> = {}): Sticker {
  return {
    id: FIRST_STICKER_ID,
    packId: PACK_ID,
    pack: undefined as unknown as StickerPack,
    slug: 'blip-hi',
    label: 'Blip says hi',
    labelPt: 'Blip diz olá',
    storageKey: STORAGE_KEY,
    width: 512,
    height: 512,
    svgSource: '<svg></svg>',
    templateId: 'blip',
    templateParams: {},
    keywords: { en: ['hi'], pt: ['olá'] },
    sortOrder: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makePack(
  status: StickerPackStatus,
  stickers: Sticker[],
  overrides: Partial<StickerPack> = {},
): StickerPack {
  return {
    id: PACK_ID,
    slug: 'blip',
    name: 'Blip',
    namePt: 'Blip',
    description: null,
    status,
    sortOrder: 0,
    coverStickerId: null,
    createdById: ADMIN_ID,
    stickers,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function build(pack: StickerPack | null) {
  const packRepository = {
    findOne: jest.fn().mockResolvedValue(pack),
    find: jest.fn().mockResolvedValue(pack ? [pack] : []),
    create: jest.fn((entity: Partial<StickerPack>) => entity),
    save: jest.fn((entity: Partial<StickerPack>) =>
      Promise.resolve({ id: PACK_ID, ...entity }),
    ),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const stickerRepository = {
    findOne: jest.fn(),
    count: jest.fn(({ where }: { where: { id?: string; packId: string } }) =>
      Promise.resolve(
        (pack?.stickers ?? []).filter(
          (sticker) => where.id === undefined || sticker.id === where.id,
        ).length,
      ),
    ),
    create: jest.fn((entity: Partial<Sticker>) => entity),
    save: jest.fn((entity: Partial<Sticker>) =>
      Promise.resolve({
        id: SECOND_STICKER_ID,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        ...entity,
      }),
    ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const service = new AdminStickersService(
    packRepository as unknown as Repository<StickerPack>,
    stickerRepository as unknown as Repository<Sticker>,
  );
  return { service, packRepository, stickerRepository };
}

describe('AdminStickersService', () => {
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('removeSticker', () => {
    it('refuses to remove the last sticker of a published pack', async () => {
      const { service, stickerRepository } = build(
        makePack(StickerPackStatus.Published, [makeSticker()]),
      );

      const removal = service.removeSticker(PACK_ID, FIRST_STICKER_ID);

      await expect(removal).rejects.toBeInstanceOf(BadRequestException);
      await expect(removal).rejects.toMatchObject({
        response: { code: LAST_STICKER_IN_PUBLISHED_PACK_CODE },
      });
      expect(stickerRepository.delete).not.toHaveBeenCalled();
    });

    it('removes a published pack sticker while another one remains', async () => {
      const { service, stickerRepository } = build(
        makePack(StickerPackStatus.Published, [
          makeSticker(),
          makeSticker({ id: SECOND_STICKER_ID, slug: 'blip-yay' }),
        ]),
      );

      await service.removeSticker(PACK_ID, FIRST_STICKER_ID);

      expect(stickerRepository.delete).toHaveBeenCalledWith({
        id: FIRST_STICKER_ID,
        packId: PACK_ID,
      });
    });

    it.each([StickerPackStatus.Draft, StickerPackStatus.Archived])(
      'removes the last sticker of a %s pack',
      async (status) => {
        const { service, stickerRepository } = build(
          makePack(status, [makeSticker()]),
        );

        await service.removeSticker(PACK_ID, FIRST_STICKER_ID);

        expect(stickerRepository.delete).toHaveBeenCalledTimes(1);
      },
    );

    it('answers 404 for a sticker that is not in the pack', async () => {
      const { service, stickerRepository } = build(
        makePack(StickerPackStatus.Published, [makeSticker()]),
      );

      await expect(
        service.removeSticker(PACK_ID, SECOND_STICKER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(stickerRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('Portuguese names', () => {
    it('stores labelPt on create and returns it beside label', async () => {
      const { service, stickerRepository } = build(
        makePack(StickerPackStatus.Draft, []),
      );

      const created = await service.addSticker(
        PACK_ID,
        {
          slug: 'blip-hi',
          label: 'Blip says hi',
          labelPt: 'Blip diz olá',
          storageKey: STORAGE_KEY,
          width: 512,
          height: 512,
          svgSource: '<svg></svg>',
          templateId: 'blip',
          templateParams: {},
        },
        ADMIN_ID,
      );

      expect(stickerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Blip says hi',
          labelPt: 'Blip diz olá',
        }),
      );
      expect(created).toMatchObject({
        label: 'Blip says hi',
        labelPt: 'Blip diz olá',
      });
    });

    it('stores null when a create carries no labelPt', async () => {
      const { service, stickerRepository } = build(
        makePack(StickerPackStatus.Draft, []),
      );

      const created = await service.addSticker(
        PACK_ID,
        {
          slug: 'blip-hi',
          label: 'Blip says hi',
          storageKey: STORAGE_KEY,
          width: 512,
          height: 512,
          svgSource: '<svg></svg>',
          templateId: 'blip',
          templateParams: {},
        },
        ADMIN_ID,
      );

      expect(stickerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ labelPt: null }),
      );
      expect(created.labelPt).toBeNull();
    });

    it('updates labelPt alone and clears it on an explicit null', async () => {
      const { service, stickerRepository } = build(null);
      stickerRepository.findOne.mockResolvedValueOnce(makeSticker());

      const renamed = await service.updateSticker(
        PACK_ID,
        FIRST_STICKER_ID,
        { labelPt: 'Blip a acenar' },
        ADMIN_ID,
      );
      expect(renamed).toMatchObject({
        label: 'Blip says hi',
        labelPt: 'Blip a acenar',
      });

      stickerRepository.findOne.mockResolvedValueOnce(makeSticker());
      const cleared = await service.updateSticker(
        PACK_ID,
        FIRST_STICKER_ID,
        { labelPt: null },
        ADMIN_ID,
      );
      expect(cleared.labelPt).toBeNull();
      expect(cleared.label).toBe('Blip says hi');
    });

    it('stores namePt on pack create and returns it in the admin response', async () => {
      const { service, packRepository } = build(null);
      packRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(
        makePack(StickerPackStatus.Draft, [], {
          name: 'Tea, shade and sparkle',
          namePt: 'Cusquice, veneno e brilho',
        }),
      );

      const created = await service.createPack(
        {
          slug: 'tea',
          name: 'Tea, shade and sparkle',
          namePt: 'Cusquice, veneno e brilho',
        },
        ADMIN_ID,
      );

      expect(packRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ namePt: 'Cusquice, veneno e brilho' }),
      );
      expect(created).toMatchObject({
        name: 'Tea, shade and sparkle',
        namePt: 'Cusquice, veneno e brilho',
      });
    });

    it('sets namePt on update and clears it on an explicit null', async () => {
      const pack = makePack(StickerPackStatus.Draft, [], { namePt: null });
      const { service, packRepository } = build(pack);

      await service.updatePack(PACK_ID, { namePt: 'Cusquice' });
      expect(packRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'Blip', namePt: 'Cusquice' }),
      );

      await service.updatePack(PACK_ID, { namePt: null });
      expect(packRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ namePt: null }),
      );
    });

    it('returns labelPt on every sticker of the admin pack list', async () => {
      const { service } = build(
        makePack(StickerPackStatus.Published, [makeSticker()]),
      );

      const packs = await service.listPacks();

      expect(packs).toHaveLength(1);
      const [pack] = packs;
      if (!pack) throw new Error('listPacks returned no pack');
      expect(pack.namePt).toBe('Blip');
      expect(pack.stickers[0]).toMatchObject({
        label: 'Blip says hi',
        labelPt: 'Blip diz olá',
      });
    });
  });
});
