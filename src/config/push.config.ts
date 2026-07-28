import { registerAs } from '@nestjs/config';

// Web Push VAPID credentials. Generated once with
// `npx web-push generate-vapid-keys`. The private key must never leave the
// backend; the public key is also shipped to the browser as
// VITE_VAPID_PUBLIC_KEY. vapidSubject is a `mailto:` or https URL identifying
// the sender to push services.
export default registerAs('push', () => ({
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  vapidSubject: process.env.VAPID_SUBJECT,
}));
