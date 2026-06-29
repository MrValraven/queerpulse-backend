# NestJS WebSockets Reference

NestJS v11 + TypeScript + socket.io. Targets a `@WebSocketGateway` with namespace `/chat`, JWT-authenticated handshake, and presence tracking. DI, exception filters, pipes, guards, and interceptors all work in gateways exactly as in HTTP; this file covers the WS-specific deltas.

## Installation & platform

```bash
pnpm add @nestjs/websockets @nestjs/platform-socket.io socket.io
# ws-based alternative (no namespaces): @nestjs/platform-ws
```

Two platforms ship out of the box: **socket.io** (`@nestjs/platform-socket.io`) and **ws** (`@nestjs/platform-ws`). Gateways are platform-agnostic classes; the adapter binds them to a concrete library. This project uses socket.io.

## Gateways

A gateway is a class annotated with `@WebSocketGateway()`. Gateways are **providers** — they support constructor DI and can themselves be injected into other providers/controllers. A gateway is **not instantiated until it is listed in a module's `providers` array**.

```typescript
@Module({ providers: [ChatGateway] })
export class ChatModule {}
```

By default a gateway listens on the same port as the HTTP server. Pass a port as the first arg to override; pass options as the second arg.

### @WebSocketGateway options

First arg = port (optional). Second arg = socket.io `ServerOptions` (https://socket.io/docs/v4/server-options/) plus `namespace`.

```typescript
@WebSocketGateway(80, { namespace: 'events' })          // port + namespace
@WebSocketGateway(81, { transports: ['websocket'] })    // force WS transport (no long-polling)
```

Project-shaped config (`/chat` namespace, CORS, WS-only transport):

```typescript
@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: process.env.FRONTEND_URL, credentials: true }, // credentials:true required to send cookies/Authorization
  transports: ['websocket'],
})
export class ChatGateway { /* ... */ }
```

Common options: `namespace`, `cors`, `transports`, `path` (default `/socket.io`), `pingInterval`, `pingTimeout`, `maxHttpBufferSize`, `cookie`. Forcing `transports: ['websocket']` matters for multi-instance scaling (see Redis adapter) — it avoids sticky-session requirements for the long-polling handshake.

### @WebSocketServer() — server / namespace

Injects the native server instance from metadata stored by `@WebSocketGateway()`. Nest assigns it once ready (it is `undefined` before `afterInit`).

```typescript
import { WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketServer() server: Server;
```

**Important:** when a `namespace` is configured, `@WebSocketServer()` returns a `Namespace`, **not** a `Server`:

```typescript
import { Namespace } from 'socket.io';

@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway {
  @WebSocketServer() namespace: Namespace; // typed as Namespace, not Server
}
```

A `Namespace` exposes `.emit`, `.to(room)`, `.sockets` (Map of connected sockets), `.adapter`. To reach the root `Server` from a namespace use `namespace.server`.

### Message handlers: @SubscribeMessage / @MessageBody / @ConnectedSocket / @Ack

```typescript
import {
  SubscribeMessage, MessageBody, ConnectedSocket, WsResponse,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';

@SubscribeMessage('events')
handleEvent(@MessageBody() data: string): string {
  return data; // implicit ack of same data
}
```

- `@MessageBody()` — the payload. `@MessageBody('id')` extracts a property: `id === messageBody.id`.
- `@ConnectedSocket()` — the platform socket instance (`Socket` from socket.io).
- All imported from `@nestjs/websockets`.

```typescript
@SubscribeMessage('events')
handleEvent(
  @MessageBody() data: string,
  @ConnectedSocket() client: Socket,
): string {
  client.emit('events', data); // library-specific emit to this client
  return data;
}
```

**Non-decorator signature** (`handleEvent(client, data)`): functionally equivalent but discouraged — requires mocking the socket in unit tests **and disables interceptors** for that handler.

```typescript
@SubscribeMessage('events')
handleEvent(client: Socket, data: string): string { return data; }
```

**Acknowledgements.** Returning a value implicitly sends an ack (client supplies a callback: `socket.emit('events', payload, (data) => ...)`). For direct control use `@Ack()` (the ack callback, otherwise the 3rd positional arg):

```typescript
@SubscribeMessage('events')
handleEvent(
  @MessageBody() data: string,
  @Ack() ack: (response: { status: string; data: string }) => void,
) {
  ack({ status: 'received', data });
}
```

To **not** respond, omit `return` or return a falsy value (e.g. `undefined`).

### Returning values: WsResponse, async, observables

`WsResponse<T> = { event: string; data: T }` lets a handler emit a named event (acks fire only once and aren't supported by native ws):

```typescript
@SubscribeMessage('events')
handleEvent(@MessageBody() data: unknown): WsResponse<unknown> {
  return { event: 'events', data };
}
```

Client listens with `socket.on('events', cb)`. **Note:** if `data` relies on `ClassSerializerInterceptor`, return a **class instance** implementing `WsResponse` — plain objects are ignored by the serializer.

Handlers may be `async`, or return an `Observable` to emit **multiple** responses (one per emitted value until the stream completes):

```typescript
import { from, Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@SubscribeMessage('events')
onEvent(@MessageBody() data: unknown): Observable<WsResponse<number>> {
  return from([1, 2, 3]).pipe(map((d) => ({ event: 'events', data: d }))); // responds 3 times
}
```

### Emitting: server, client, rooms

```typescript
// broadcast to everyone in the namespace
this.server.emit('presence:update', payload);

// to one client only
client.emit('message', payload);

// rooms — join/leave then target a room
client.join(`user:${userId}`);
client.leave(`user:${userId}`);
this.server.to(`user:${userId}`).emit('dm', payload);     // all sockets in room
client.to(`room:${roomId}`).emit('typing', payload);      // room except sender
this.server.to('a').to('b').emit('x', payload);           // union of rooms
```

Each socket auto-joins a room named by its own `client.id`, so `server.to(socketId).emit(...)` targets a single connection across instances (works with the Redis adapter). Use rooms (not in-memory maps) for cross-instance fan-out.

### Lifecycle hooks

Implement the interface to be forced to implement the method. All from `@nestjs/websockets`.

| Interface | Method | Argument |
|---|---|---|
| `OnGatewayInit` | `afterInit(server)` | native server/namespace instance |
| `OnGatewayConnection` | `handleConnection(client, ...args)` | client socket |
| `OnGatewayDisconnect` | `handleDisconnect(client)` | client socket |

```typescript
import {
  OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';

@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() namespace: Namespace;

  constructor(private readonly presence: PresenceService) {}

  afterInit(server: Namespace) { /* server instance ready */ }

  async handleConnection(client: Socket) {
    // auth runs here (handshake), NOT in a guard — guards only fire on @SubscribeMessage
    try {
      const user = await this.authenticate(client);
      client.data.user = user;                 // stash for later handlers
      await client.join(`user:${user.id}`);
      await this.presence.online(user.id, client.id);
      this.namespace.emit('presence:update', { userId: user.id, online: true });
    } catch {
      client.emit('exception', { status: 'error', message: 'Unauthorized' });
      client.disconnect(true);                 // reject the connection
    }
  }

  async handleDisconnect(client: Socket) {
    const user = client.data.user;
    if (!user) return;
    const stillOnline = await this.presence.offline(user.id, client.id);
    if (!stillOnline) {
      this.namespace.emit('presence:update', { userId: user.id, online: false });
    }
  }
}
```

### Accessing the handshake (auth: token / cookies)

`client.handshake` holds the connection metadata, populated at connection time:

```typescript
client.handshake.auth.token        // socket.io: io(url, { auth: { token } })
client.handshake.headers.authorization // "Bearer ..." header
client.handshake.headers.cookie    // raw cookie string -> parse for an httpOnly JWT
client.handshake.query.token       // ?token=... query param (least preferred)
client.handshake.address           // client IP
```

Authentication belongs in `handleConnection` (and/or a guard for per-message checks). Example resolver used above:

```typescript
private async authenticate(client: Socket): Promise<JwtUser> {
  const raw =
    (client.handshake.auth?.token as string) ??
    client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') ??
    parse(client.handshake.headers.cookie ?? '')['access_token'];   // import { parse } from 'cookie'
  if (!raw) throw new WsException('Missing token');
  return this.jwt.verifyAsync<JwtUser>(raw, { secret: process.env.JWT_SECRET });
}
```

## Exception filters

Throw `WsException` instead of `HttpException`. Nest emits an `exception` event to the client:

```typescript
import { WsException } from '@nestjs/websockets';
throw new WsException('Invalid credentials.');
// client receives event 'exception' with:  { status: 'error', message: 'Invalid credentials.' }
```

WS filters behave like HTTP filters. Apply method- or gateway-scoped via `@UseFilters()`:

```typescript
@UseFilters(new WsExceptionFilter())
@SubscribeMessage('events')
onEvent(client, data: any): WsResponse<any> {
  return { event: 'events', data };
}
```

### Custom / inherited filter

Extend `BaseWsExceptionFilter` and delegate to `super.catch()`:

```typescript
import { Catch, ArgumentsHost } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';

@Catch()
export class AllExceptionsFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    // custom business logic, then fall back to the base behavior
    super.catch(exception, host);
  }
}
```

`WsException` accepts a string or object. The error payload may contain a `cause`; for validation you typically pass the class-validator errors (see Pipes). Filters can access the client via `host.switchToWs().getClient()` and the data via `.getData()`.

## Pipes

No fundamental difference from HTTP pipes. Two deltas:
1. Throw `WsException`, not `HttpException`.
2. Pipes apply **only to the `data` argument** (validating/transforming the `client` socket is useless).

Use `ValidationPipe` with an `exceptionFactory` that maps validation errors to a `WsException`:

```typescript
import { UsePipes, ValidationPipe } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

@UsePipes(new ValidationPipe({
  whitelist: true,
  transform: true,
  exceptionFactory: (errors) => new WsException(errors),
}))
@SubscribeMessage('events')
handleEvent(@MessageBody() data: SendMessageDto): WsResponse<unknown> {
  return { event: 'events', data };
}
```

`@MessageBody()` + a class-validator DTO gives validated, typed payloads. Bind globally instead with `app.useGlobalPipes(new ValidationPipe({ exceptionFactory: (e) => new WsException(e) }))` — applies to both HTTP and WS.

## Guards

Same as HTTP guards; throw `WsException` on failure. **Caveat: guards run on `@SubscribeMessage` handlers, not on the initial connection** — gate the connection in `handleConnection` and use a guard for per-message authorization.

```typescript
@UseGuards(WsJwtGuard)
@SubscribeMessage('events')
handleEvent(@ConnectedSocket() client: Socket, @MessageBody() data: unknown) {
  return { event: 'events', data };
}
```

### JWT guard reading the handshake (token / cookie)

Switch the execution context to WS with `host.switchToWs()`; `getClient()` returns the socket, `getData()` the message payload.

```typescript
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { parse } from 'cookie';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();

    // reuse the user resolved at connection time if present
    if (client.data?.user) return true;

    const token =
      (client.handshake.auth?.token as string) ??
      client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') ??
      parse(client.handshake.headers.cookie ?? '')['access_token'];

    if (!token) throw new WsException('Unauthorized');
    try {
      client.data.user = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });
      return true;
    } catch {
      throw new WsException('Unauthorized');
    }
  }
}
```

`context.switchToWs()` also exposes `.getData<T>()` for the message body and `.getPattern()` for the event name.

## Interceptors

Identical to HTTP interceptors (`NestInterceptor`, `intercept(context, next)`, `next.handle()` returns an `Observable`). Bind method- or gateway-scoped via `@UseInterceptors()`.

```typescript
@UseInterceptors(new TransformInterceptor())
@SubscribeMessage('events')
handleEvent(@ConnectedSocket() client: Socket, @MessageBody() data: unknown): WsResponse<unknown> {
  return { event: 'events', data };
}
```

```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    // const client = ctx.switchToWs().getClient();
    return next.handle().pipe(map((data) => ({ event: 'events', data })));
  }
}
```

**Reminder:** the non-decorator handler signature `(client, data)` disables interceptors — always use `@ConnectedSocket()`/`@MessageBody()` if you rely on them.

## Adapters

The WS module is platform-agnostic via the `WebSocketAdapter` interface. socket.io is wrapped by `IoAdapter` (from `@nestjs/platform-socket.io`); ws by `WsAdapter` (from `@nestjs/platform-ws`).

`WebSocketAdapter` required methods: `create` (build a server), `bindClientConnect`, `bindClientDisconnect` (optional), `bindMessageHandlers`, `close`.

### Redis adapter (scaling across instances)

For broadcasting across load-balanced instances, extend `IoAdapter` and attach `@socket.io/redis-adapter`. **Redis alone is not enough for socket.io scaling** — either set `transports: ['websocket']` on clients, or enable cookie-based sticky sessions in the load balancer (so the long-polling handshake reaches the same node).

```bash
pnpm add redis socket.io @socket.io/redis-adapter
```

```typescript
// redis-io.adapter.ts
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  async connectToRedis(): Promise<void> {
    const pubClient = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options); // CORS/namespace options flow through here
    server.adapter(this.adapterConstructor);
    return server;
  }
}
```

Wire it in `main.ts` before the app starts listening:

```typescript
// main.ts
const app = await NestFactory.create(AppModule);
const redisIoAdapter = new RedisIoAdapter(app);
await redisIoAdapter.connectToRedis();
app.useWebSocketAdapter(redisIoAdapter);
await app.listen(process.env.PORT ?? 3000);
```

With the Redis adapter active, `server.emit`, `server.to(room).emit`, and room joins propagate across all instances — so presence rooms (`user:<id>`) and broadcasts work cluster-wide. Keep ephemeral per-socket presence behind a service (e.g. a Redis-backed `PresenceService`) rather than in-process maps so it survives the multi-node fan-out.

### ws library adapter

`ws` is faster than socket.io but has fewer features and **no namespaces** (mimic with distinct paths: `@WebSocketGateway({ path: '/users' })`).

```typescript
import { WsAdapter } from '@nestjs/platform-ws';
const app = await NestFactory.create(AppModule);
app.useWebSocketAdapter(new WsAdapter(app));
```

`WsAdapter` expects messages in `{ event: string, data: any }` form. To accept another wire format, pass a `messageParser` (or call `setMessageParser` later):

```typescript
const wsAdapter = new WsAdapter(app, {
  // handle [event, data] arrays
  messageParser: (data) => {
    const [event, payload] = JSON.parse(data.toString());
    return { event, data: payload };
  },
});
```

### Custom adapter skeleton

Implement `WebSocketAdapter` directly (simplified `WsAdapter`; prefer the built-in unless you truly need a bespoke transport):

```typescript
import * as WebSocket from 'ws';
import { WebSocketAdapter, INestApplicationContext } from '@nestjs/common';
import { MessageMappingProperties } from '@nestjs/websockets';
import { Observable, fromEvent, EMPTY } from 'rxjs';
import { mergeMap, filter } from 'rxjs/operators';

export class WsAdapter implements WebSocketAdapter {
  constructor(private app: INestApplicationContext) {}

  create(port: number, options: any = {}): any {
    return new WebSocket.Server({ port, ...options });
  }

  bindClientConnect(server, callback: Function) {
    server.on('connection', callback);
  }

  bindMessageHandlers(
    client: WebSocket,
    handlers: MessageMappingProperties[],
    process: (data: any) => Observable<any>,
  ) {
    fromEvent(client, 'message')
      .pipe(
        mergeMap((data) => this.bindMessageHandler(data, handlers, process)),
        filter((result) => result),
      )
      .subscribe((response) => client.send(JSON.stringify(response)));
  }

  bindMessageHandler(buffer, handlers: MessageMappingProperties[], process: (data: any) => Observable<any>): Observable<any> {
    const message = JSON.parse(buffer.data);
    const messageHandler = handlers.find((h) => h.message === message.event);
    if (!messageHandler) return EMPTY;
    return process(messageHandler.callback(message.data));
  }

  close(server) { server.close(); }
}
```

Register any custom/built-in adapter with `app.useWebSocketAdapter(new MyAdapter(app))` in `main.ts`.

## Quick gotchas

- Guards/pipes/interceptors/filters bind via `@UseGuards`/`@UsePipes`/`@UseInterceptors`/`@UseFilters` at method or gateway (class) scope — same decorators as HTTP.
- Authentication for the connection itself must happen in `handleConnection` (guards don't run on connect). Call `client.disconnect(true)` to reject.
- With a `namespace`, `@WebSocketServer()` yields a `Namespace`; `.server` reaches the root.
- Non-decorator handler signature disables interceptors and complicates testing — avoid it.
- Force `transports: ['websocket']` for clean multi-instance scaling; Redis adapter alone doesn't solve the long-polling handshake stickiness.
- Validation: `ValidationPipe({ exceptionFactory: (e) => new WsException(e) })` so errors surface as the `exception` event, not an HTTP 400.
