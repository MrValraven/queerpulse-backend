import {
  DEVICE_LABEL_MAX_LENGTH,
  UNKNOWN_DEVICE_LABEL,
  deviceLabelFromUserAgent,
  deviceLabelPartsFromUserAgent,
} from './device-label';

describe('deviceLabelFromUserAgent', () => {
  it('names the browser and the platform', () => {
    expect(
      deviceLabelFromUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
  });

  it('reads an iPhone as Safari on iPhone', () => {
    expect(
      deviceLabelFromUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone');
  });

  it('prefers Edge over the Chrome token Edge also carries', () => {
    expect(
      deviceLabelFromUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      ),
    ).toBe('Edge on Windows');
  });

  it('prefers Android over the Linux token Android also carries', () => {
    expect(
      deviceLabelFromUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
  });

  it('reads Chrome on iOS through its CriOS token', () => {
    expect(
      deviceLabelFromUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Chrome on iPhone');
  });

  it('falls back to the half it recognises', () => {
    expect(deviceLabelFromUserAgent('QueerPulse/1.0 (Linux)')).toBe('Linux');
    expect(deviceLabelFromUserAgent('Firefox/1.0')).toBe('Firefox');
  });

  it('never guesses from nothing', () => {
    expect(deviceLabelFromUserAgent(undefined)).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceLabelFromUserAgent(null)).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceLabelFromUserAgent('')).toBe(UNKNOWN_DEVICE_LABEL);
    expect(deviceLabelFromUserAgent('curl/8.4.0')).toBe(UNKNOWN_DEVICE_LABEL);
  });

  it('is stable across browser versions, so an update is not a new device', () => {
    const before =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const after = before.replace('126.0.0.0', '131.0.6778.85');
    expect(deviceLabelFromUserAgent(after)).toBe(
      deviceLabelFromUserAgent(before),
    );
  });

  it('never exceeds the column it is stored in', () => {
    const label = deviceLabelFromUserAgent('x'.repeat(4000));
    expect(label.length).toBeLessThanOrEqual(DEVICE_LABEL_MAX_LENGTH);
  });

  it('exposes the parts separately for callers that phrase their own label', () => {
    expect(
      deviceLabelPartsFromUserAgent(
        'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/128.0',
      ),
    ).toEqual({ browser: 'Firefox', platform: 'Windows' });
  });
});
