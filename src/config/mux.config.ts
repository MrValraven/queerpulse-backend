import { registerAs } from '@nestjs/config';

export default registerAs('mux', () => ({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
  webhookSecret: process.env.MUX_WEBHOOK_SECRET,
  signingKeyId: process.env.MUX_SIGNING_KEY_ID,
  // base64-encoded PEM private key, exactly as issued by Mux
  signingPrivateKey: process.env.MUX_SIGNING_PRIVATE_KEY,
}));
