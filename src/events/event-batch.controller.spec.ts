import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { allowsSharedUploads } from '../storage/shared-upload-handlers';
import { EventBatchThrottlerGuard } from './event-batch-throttler.guard';
import { EventsController } from './events.controller';

const MEMBER = { userId: 'user-1' } as never;

const prototypeRecord = EventsController.prototype as unknown as Record<
  string,
  object | undefined
>;

const handlerOf = (methodName: string): object => {
  const handler = prototypeRecord[methodName];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

const buildController = (eventBatchTemplates: object, eventBatch: object) =>
  new EventsController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // MemberEventInvitesService
    {} as never,
    eventBatchTemplates as never,
    eventBatch as never,
  );

describe('EventsController batch routes', () => {
  it('GET /events/:slug/batch-template forwards the slug and the caller', async () => {
    const view = { slug: 'quiz-night' };
    const eventBatchTemplates = {
      getTemplateView: jest.fn().mockResolvedValue(view),
    };
    const controller = buildController(eventBatchTemplates, {});

    const result = await controller.getBatchTemplate(MEMBER, 'quiz-night');

    expect(eventBatchTemplates.getTemplateView).toHaveBeenCalledWith(
      'quiz-night',
      'user-1',
    );
    expect(result).toBe(view);
  });

  it('POST /events/batch forwards the caller and the body', async () => {
    const created = { events: [] };
    const eventBatch = { createBatch: jest.fn().mockResolvedValue(created) };
    const controller = buildController({}, eventBatch);
    const body = { templateSlug: 'quiz-night', shared: {}, rows: [] } as never;

    const result = await controller.createBatch(MEMBER, body);

    expect(eventBatch.createBatch).toHaveBeenCalledWith('user-1', body);
    expect(result).toBe(created);
  });

  it('tags both routes with the eventBatch feature over the class events tag', () => {
    expect(Reflect.getMetadata(FEATURE_KEY, handlerOf('createBatch'))).toBe(
      'eventBatch',
    );
    expect(
      Reflect.getMetadata(FEATURE_KEY, handlerOf('getBatchTemplate')),
    ).toBe('eventBatch');
    expect(Reflect.getMetadata(FEATURE_KEY, EventsController)).toBe('events');
  });

  it('keeps restricted members off the batch and throttles it per member', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      handlerOf('createBatch'),
    ) as unknown[];

    expect(guards).toContain(NotRestrictedGuard);
    expect(guards).toContain(EventBatchThrottlerGuard);
  });

  it('leaves the shared IP throttle bucket at the app default', () => {
    const metadataKeys = Reflect.getMetadataKeys(handlerOf('createBatch'));

    expect(
      metadataKeys.some((metadataKey) =>
        String(metadataKey).startsWith('THROTTLER:'),
      ),
    ).toBe(false);
  });

  it('keeps every cover in a batch body on the strict upload rule', () => {
    expect(allowsSharedUploads('EventsController', 'createBatch')).toBe(false);
  });
});
