import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CinemaService } from './cinema.service';
import { MuxService } from './mux.service';
import { CinemaWebhooksController } from './webhooks.controller';

describe('CinemaWebhooksController', () => {
  let controller: CinemaWebhooksController;
  let mux: { verifyWebhook: jest.Mock };
  let cinema: {
    onUploadAssetCreated: jest.Mock;
    onAssetReady: jest.Mock;
    onAssetErrored: jest.Mock;
    onUploadFailed: jest.Mock;
  };

  function request(body: unknown = { any: 'thing' }) {
    return {
      rawBody: Buffer.from(JSON.stringify(body)),
      headers: { 'mux-signature': 't=1,v1=abc' },
    } as never;
  }

  beforeEach(async () => {
    mux = { verifyWebhook: jest.fn() };
    cinema = {
      onUploadAssetCreated: jest.fn(),
      onAssetReady: jest.fn(),
      onAssetErrored: jest.fn(),
      onUploadFailed: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CinemaWebhooksController],
      providers: [
        { provide: MuxService, useValue: mux },
        { provide: CinemaService, useValue: cinema },
      ],
    }).compile();
    controller = module.get(CinemaWebhooksController);
  });

  it('propagates signature failures without touching state', async () => {
    mux.verifyWebhook.mockRejectedValue(new ForbiddenException());
    await expect(controller.handleMux(request())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(cinema.onUploadAssetCreated).not.toHaveBeenCalled();
    expect(cinema.onAssetReady).not.toHaveBeenCalled();
  });

  it('400s when the raw body is missing', async () => {
    await expect(
      controller.handleMux({ rawBody: undefined, headers: {} } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mux.verifyWebhook).not.toHaveBeenCalled();
  });

  it('dispatches video.upload.asset_created', async () => {
    mux.verifyWebhook.mockResolvedValue({
      type: 'video.upload.asset_created',
      data: { id: 'up-1', asset_id: 'as-1' },
    });
    const result = await controller.handleMux(request());
    expect(cinema.onUploadAssetCreated).toHaveBeenCalledWith('up-1', 'as-1');
    expect(result).toEqual({ received: true });
  });

  it('dispatches video.asset.ready with mapped metadata', async () => {
    mux.verifyWebhook.mockResolvedValue({
      type: 'video.asset.ready',
      data: {
        id: 'as-1',
        playback_ids: [{ id: 'pb-1', policy: 'signed' }],
        duration: 7199.62,
        aspect_ratio: '16:9',
      },
    });
    await controller.handleMux(request());
    expect(cinema.onAssetReady).toHaveBeenCalledWith('as-1', {
      playbackId: 'pb-1',
      durationSeconds: 7200,
      aspectRatio: '16:9',
    });
  });

  it('dispatches video.asset.errored with joined messages', async () => {
    mux.verifyWebhook.mockResolvedValue({
      type: 'video.asset.errored',
      data: {
        id: 'as-1',
        errors: { type: 'invalid_input', messages: ['bad codec', 'no audio'] },
      },
    });
    await controller.handleMux(request());
    expect(cinema.onAssetErrored).toHaveBeenCalledWith(
      'as-1',
      'bad codec; no audio',
    );
  });

  it('dispatches upload failures for errored and cancelled', async () => {
    mux.verifyWebhook.mockResolvedValue({
      type: 'video.upload.errored',
      data: { id: 'up-1' },
    });
    await controller.handleMux(request());
    expect(cinema.onUploadFailed).toHaveBeenCalledWith(
      'up-1',
      'video.upload.errored',
    );

    mux.verifyWebhook.mockResolvedValue({
      type: 'video.upload.cancelled',
      data: { id: 'up-2' },
    });
    await controller.handleMux(request());
    expect(cinema.onUploadFailed).toHaveBeenCalledWith(
      'up-2',
      'video.upload.cancelled',
    );
  });

  it('acknowledges unknown event types without dispatching', async () => {
    mux.verifyWebhook.mockResolvedValue({
      type: 'video.asset.created',
      data: { id: 'as-1' },
    });
    const result = await controller.handleMux(request());
    expect(result).toEqual({ received: true });
    expect(cinema.onUploadAssetCreated).not.toHaveBeenCalled();
    expect(cinema.onAssetReady).not.toHaveBeenCalled();
    expect(cinema.onAssetErrored).not.toHaveBeenCalled();
    expect(cinema.onUploadFailed).not.toHaveBeenCalled();
  });
});
