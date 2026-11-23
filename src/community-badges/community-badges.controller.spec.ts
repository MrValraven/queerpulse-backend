import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { CommunityBadgesController } from './community-badges.controller';
import { CommunityBadgesService } from './community-badges.service';
import { CommunityGiftsService } from './community-gifts.service';

// @nestjs/throttler does not re-export `throttler.constants` from its package
// root; `@Throttle` writes `THROTTLER:LIMIT` and `THROTTLER:TTL` plus the
// throttler name onto the handler (verified against @nestjs/throttler 6.5.0).
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

const user = {
  userId: 'u1',
  email: 'member@example.test',
  status: 'active',
  role: 'member',
} as CurrentUserData;

/** Every handler with its verb and path, in the order the class declares them. */
const ROUTE_TABLE = [
  ['listBadges', RequestMethod.GET, 'badges'],
  ['listBadgesForStaff', RequestMethod.GET, 'badges/manage'],
  ['createBadge', RequestMethod.POST, 'badges'],
  ['updateBadge', RequestMethod.PATCH, 'badges/:badgeId'],
  ['deleteBadge', RequestMethod.DELETE, 'badges/:badgeId'],
  ['setFlair', RequestMethod.PUT, 'flair'],
  ['giftAllowance', RequestMethod.GET, 'gifts/allowance'],
  ['listMyGifts', RequestMethod.GET, 'gifts/mine'],
  ['sendGift', RequestMethod.POST, 'gifts'],
  ['updateGift', RequestMethod.PATCH, 'gifts/:giftId'],
  ['deleteGift', RequestMethod.DELETE, 'gifts/:giftId'],
  ['listMemberGifts', RequestMethod.GET, 'members/:memberSlug/gifts'],
] as const;

type HandlerFunction = (...args: unknown[]) => unknown;

const handlerOf = (handlerName: string): HandlerFunction => {
  const handler = (
    CommunityBadgesController.prototype as unknown as Record<
      string,
      HandlerFunction | undefined
    >
  )[handlerName];
  if (!handler) {
    throw new Error(`No handler named ${handlerName} on the controller`);
  }
  return handler;
};

describe('CommunityBadgesController metadata', () => {
  it('sits under communities/:slug behind the active member guard and the communities feature', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CommunityBadgesController)).toBe(
      'communities/:slug',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CommunityBadgesController),
    ).toEqual([ActiveMemberGuard]);
    expect(Reflect.getMetadata(FEATURE_KEY, CommunityBadgesController)).toBe(
      'communities',
    );
  });

  it('maps the 12 handlers to the contract verbs and paths in declaration order', () => {
    const declaredNames = Object.getOwnPropertyNames(
      CommunityBadgesController.prototype,
    ).filter((propertyName) => propertyName !== 'constructor');
    expect(declaredNames).toEqual(
      ROUTE_TABLE.map(([handlerName]) => handlerName),
    );

    const routes = ROUTE_TABLE.map(([handlerName]) => [
      handlerName,
      Reflect.getMetadata(METHOD_METADATA, handlerOf(handlerName)) as number,
      Reflect.getMetadata(PATH_METADATA, handlerOf(handlerName)) as string,
    ]);
    expect(routes).toEqual(ROUTE_TABLE.map((route) => [...route]));
  });

  it('declares the literal gift and badge paths above the parameterised ones', () => {
    const declaredPaths = ROUTE_TABLE.map(([, , path]) => path as string);
    expect(declaredPaths.indexOf('badges/manage')).toBeLessThan(
      declaredPaths.indexOf('badges/:badgeId'),
    );
    expect(declaredPaths.indexOf('gifts/allowance')).toBeLessThan(
      declaredPaths.indexOf('gifts/:giftId'),
    );
    expect(declaredPaths.indexOf('gifts/mine')).toBeLessThan(
      declaredPaths.indexOf('gifts/:giftId'),
    );
  });

  it.each([
    'createBadge',
    'updateBadge',
    'deleteBadge',
    'setFlair',
    'sendGift',
    'updateGift',
    'deleteGift',
  ])('restricts and throttles the write %s', (handlerName) => {
    const method = handlerOf(handlerName);
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
      NotRestrictedGuard,
    ]);
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, method)).toBe(20);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, method)).toBe(60000);
  });

  it.each([
    'listBadges',
    'listBadgesForStaff',
    'giftAllowance',
    'listMyGifts',
    'listMemberGifts',
  ])('leaves the read %s unthrottled', (handlerName) => {
    const method = handlerOf(handlerName);
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toBeUndefined();
    expect(
      Reflect.getMetadata(`${THROTTLER_LIMIT}default`, method),
    ).toBeUndefined();
  });

  it('answers 200 on both deletes and the default 201 on both creates', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('deleteBadge')),
    ).toBe(HttpStatus.OK);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('deleteGift')),
    ).toBe(HttpStatus.OK);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('createBadge')),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('sendGift')),
    ).toBeUndefined();
  });
});

describe('CommunityBadgesController delegation', () => {
  let badges: Record<string, jest.Mock>;
  let gifts: Record<string, jest.Mock>;
  let controller: CommunityBadgesController;

  beforeEach(() => {
    badges = {
      listForViewer: jest.fn().mockResolvedValue({ badges: [] }),
      listForStaff: jest.fn().mockResolvedValue({ badges: [] }),
      create: jest.fn().mockResolvedValue({ id: 'badge-1' }),
      update: jest.fn().mockResolvedValue({ id: 'badge-1' }),
      remove: jest.fn().mockResolvedValue({ id: 'badge-1', holderCount: 3 }),
      setFlair: jest.fn().mockResolvedValue({ flair: null }),
    };
    gifts = {
      allowance: jest.fn().mockResolvedValue({ limit: 10 }),
      send: jest.fn().mockResolvedValue({ id: 'gift-1' }),
      listMine: jest.fn().mockResolvedValue({ items: [] }),
      setHidden: jest.fn().mockResolvedValue({ id: 'gift-1' }),
      remove: jest.fn().mockResolvedValue({ id: 'gift-1' }),
      listMemberMarks: jest.fn().mockResolvedValue({ gifts: [] }),
    };
    controller = new CommunityBadgesController(
      badges as unknown as CommunityBadgesService,
      gifts as unknown as CommunityGiftsService,
    );
  });

  it('passes the page query through to the shelf', async () => {
    await controller.listMyGifts(user, 'night-swim', { page: '2' });
    expect(gifts.listMine).toHaveBeenCalledWith('night-swim', 'u1', '2');
  });

  it('passes the slug, the caller id, the ids and the bodies to the badge service', async () => {
    const createBody = { name: 'Regular', iconKey: 'star' };
    const updateBody = { threshold: 5 };
    const flairBody = { badgeId: null };

    await controller.listBadges(user, 'night-swim');
    await controller.listBadgesForStaff(user, 'night-swim');
    await controller.createBadge(user, 'night-swim', createBody);
    await controller.updateBadge(user, 'night-swim', 'badge-1', updateBody);
    await controller.deleteBadge(user, 'night-swim', 'badge-1');
    await controller.setFlair(user, 'night-swim', flairBody);

    expect(badges.listForViewer).toHaveBeenCalledWith('night-swim', 'u1');
    expect(badges.listForStaff).toHaveBeenCalledWith('night-swim', 'u1');
    expect(badges.create).toHaveBeenCalledWith('night-swim', 'u1', createBody);
    expect(badges.update).toHaveBeenCalledWith(
      'night-swim',
      'u1',
      'badge-1',
      updateBody,
    );
    expect(badges.remove).toHaveBeenCalledWith('night-swim', 'u1', 'badge-1');
    expect(badges.setFlair).toHaveBeenCalledWith('night-swim', 'u1', flairBody);
  });

  it('passes the slug, the caller id, the ids and the bodies to the gift service', async () => {
    const sendBody = { recipientSlug: 'sam', giftKey: 'flower' };
    const hideBody = { isHidden: true };

    await controller.giftAllowance(user, 'night-swim');
    await controller.sendGift(user, 'night-swim', sendBody);
    await controller.updateGift(user, 'night-swim', 'gift-1', hideBody);
    await controller.deleteGift(user, 'night-swim', 'gift-1');
    await controller.listMemberGifts(user, 'night-swim', 'sam');

    expect(gifts.allowance).toHaveBeenCalledWith('night-swim', 'u1');
    expect(gifts.send).toHaveBeenCalledWith('night-swim', 'u1', sendBody);
    expect(gifts.setHidden).toHaveBeenCalledWith(
      'night-swim',
      'u1',
      'gift-1',
      hideBody,
    );
    expect(gifts.remove).toHaveBeenCalledWith('night-swim', 'u1', 'gift-1');
    expect(gifts.listMemberMarks).toHaveBeenCalledWith(
      'night-swim',
      'u1',
      'sam',
    );
  });

  it('returns what the service resolves', async () => {
    await expect(
      controller.deleteBadge(user, 'night-swim', 'badge-1'),
    ).resolves.toEqual({ id: 'badge-1', holderCount: 3 });
  });
});
