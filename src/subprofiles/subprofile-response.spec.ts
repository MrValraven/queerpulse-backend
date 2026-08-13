import { toItemView } from './subprofile-response';
import { SubprofileItem } from './entities/subprofile-item.entity';

describe('toItemView', () => {
  it('exposes createdAt as an ISO string', () => {
    const item = Object.assign(new SubprofileItem(), {
      id: 'item-1',
      section: 'poems',
      title: 'Pecado',
      structured: { poem: [] },
      createdAt: new Date('2025-07-14T09:32:00.000Z'),
    });
    const view = toItemView(item, new Map());
    expect(view.createdAt).toBe('2025-07-14T09:32:00.000Z');
  });
});
