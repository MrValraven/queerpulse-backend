import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePersonaPostDto } from './create-persona-post.dto';
import { ListPersonaPostsQuery } from './list-persona-posts.query';
import { UpdatePersonaPostDto } from './update-persona-post.dto';

const errorsFor = async <BodyClass extends object>(
  dtoClass: ClassConstructor<BodyClass>,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Persona post bodies', () => {
  it('trims the body and keeps up to 500 characters', async () => {
    const trimmed = plainToInstance(CreatePersonaPostDto, {
      body: '  Out Friday  ',
    });
    expect(trimmed.body).toBe('Out Friday');
    expect(
      await errorsFor(CreatePersonaPostDto, { body: 'x'.repeat(500) }),
    ).toEqual([]);
  });

  it('refuses a blank body, a 501 character body and a missing one', async () => {
    expect(await errorsFor(CreatePersonaPostDto, { body: '   ' })).toEqual([
      'body',
    ]);
    expect(
      await errorsFor(CreatePersonaPostDto, { body: 'x'.repeat(501) }),
    ).toEqual(['body']);
    expect(await errorsFor(CreatePersonaPostDto, {})).toEqual(['body']);
  });

  it('takes an https link, reads an empty one as no link and refuses a scripting one', async () => {
    expect(
      await errorsFor(CreatePersonaPostDto, {
        body: 'Out Friday',
        linkUrl: 'https://nightshift.bandcamp.com',
      }),
    ).toEqual([]);
    expect(
      await errorsFor(CreatePersonaPostDto, {
        body: 'Out Friday',
        linkUrl: '',
      }),
    ).toEqual([]);
    expect(
      await errorsFor(CreatePersonaPostDto, {
        body: 'Out Friday',
        linkUrl: null,
      }),
    ).toEqual([]);
    for (const linkUrl of ['javascript:alert(1)', 'http://x.test', 'x.test']) {
      expect(
        await errorsFor(CreatePersonaPostDto, { body: 'Out Friday', linkUrl }),
      ).toEqual(['linkUrl']);
    }
  });

  it('refuses a mailto link and an http link on create and on edit', async () => {
    for (const linkUrl of [
      'mailto:booking@nightshift.test',
      'http://nightshift.bandcamp.com',
    ]) {
      expect(
        await errorsFor(CreatePersonaPostDto, { body: 'Out Friday', linkUrl }),
      ).toEqual(['linkUrl']);
      expect(await errorsFor(UpdatePersonaPostDto, { linkUrl })).toEqual([
        'linkUrl',
      ]);
    }
    expect(
      await errorsFor(UpdatePersonaPostDto, {
        linkUrl: 'https://nightshift.bandcamp.com',
      }),
    ).toEqual([]);
  });

  it('refuses an image that is no image reference', async () => {
    expect(
      await errorsFor(CreatePersonaPostDto, {
        body: 'Out Friday',
        imageKey: 'javascript:alert(1)',
      }),
    ).toEqual(['imageKey']);
  });

  it('edits with any subset, clears the link and the photo with null, and refuses a null body', async () => {
    expect(await errorsFor(UpdatePersonaPostDto, {})).toEqual([]);
    expect(
      await errorsFor(UpdatePersonaPostDto, { linkUrl: null, imageKey: null }),
    ).toEqual([]);
    expect(await errorsFor(UpdatePersonaPostDto, { body: null })).toEqual([
      'body',
    ]);
  });

  it('caps the cursor', async () => {
    expect(
      await errorsFor(ListPersonaPostsQuery, { cursor: 'x'.repeat(201) }),
    ).toEqual(['cursor']);
  });
});
