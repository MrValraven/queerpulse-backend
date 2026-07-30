import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CinemaService } from './cinema.service';
import { MuxService } from './mux.service';
import { CinemaWebhooksController } from './webhooks.controller';

// The controller now owns only HMAC verification and the hand-off: it verifies
// the signature over the raw body, hands the parsed event to
// `CinemaService.handleWebhookEvent`, and returns `{ received: true }`. The
// provider-payload mapping/dispatch it used to own (event switch, duration
// rounding, playback-id extraction, error-message joining, malformed-id reject)
// now lives in the service and is exercised in cinema.service.spec.ts.
describe('CinemaWebhooksController', () => {
  let controller: CinemaWebhooksController;
  let mux: { verifyWebhook: jest.Mock };
  let cinema: { handleWebhookEvent: jest.Mock };

  function request(body: unknown = { any: 'thing' }) {
    return {
      rawBody: Buffer.from(JSON.stringify(body)),
      headers: { 'mux-signature': 't=1,v1=abc' },
    } as never;
  }

  beforeEach(async () => {
    mux = { verifyWebhook: jest.fn() };
    cinema = { handleWebhookEvent: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CinemaWebhooksController],
      providers: [
        { provide: MuxService, useValue: mux },
        { provide: CinemaService, useValue: cinema },
      ],
    }).compile();
    controller = module.get(CinemaWebhooksController);
  });

  it('verifies the signature over the raw body then hands the event to the service', async () => {
    const event = { type: 'video.asset.ready', data: { id: 'as-1' } };
    mux.verifyWebhook.mockResolvedValue(event);
    const rawBody = Buffer.from(JSON.stringify({ any: 'thing' }));
    const headers = { 'mux-signature': 't=1,v1=abc' };
    const result = await controller.handleMux({ rawBody, headers } as never);
    expect(mux.verifyWebhook).toHaveBeenCalledWith(
      rawBody.toString('utf8'),
      headers,
    );
    expect(cinema.handleWebhookEvent).toHaveBeenCalledWith(event);
    expect(result).toEqual({ received: true });
  });

  it('propagates signature failures without touching state', async () => {
    mux.verifyWebhook.mockRejectedValue(new ForbiddenException());
    await expect(controller.handleMux(request())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(cinema.handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('400s when the raw body is missing, before verifying', async () => {
    await expect(
      controller.handleMux({ rawBody: undefined, headers: {} } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mux.verifyWebhook).not.toHaveBeenCalled();
    expect(cinema.handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('lets a service-side malformed-payload rejection surface (no ack)', async () => {
    // The malformed-`data.id` guard now lives in the service; the controller
    // simply propagates that rejection instead of returning { received: true }.
    mux.verifyWebhook.mockResolvedValue({
      type: 'video.asset.ready',
      data: {},
    });
    cinema.handleWebhookEvent.mockRejectedValue(new BadRequestException());
    await expect(controller.handleMux(request())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
