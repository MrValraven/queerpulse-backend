import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { normalizeOnlineListingUrl } from '../listing-online-details';

/**
 * A web link on an online listing (`onlineDetails.mainLink.url`,
 * `onlineDetails.moreLinks[].url`, `shopItems[].link`). Passes `''` (no link)
 * and anything `normalizeOnlineListingUrl` can store: a domain with or without
 * `http://` or `https://`. Every other scheme, a host with no dot, a URL
 * carrying credentials and one holding whitespace or a backslash are refused
 * here, before the service sees them.
 */
export function IsOnlineListingUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isOnlineListingUrl',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (value === '') return true;
          return normalizeOnlineListingUrl(value) !== null;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a web address (http or https) with no spaces or backslashes`;
        },
      },
    });
  };
}
