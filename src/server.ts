import process from 'node:process';
import http from 'node:http';
import {existsSync, readFileSync, writeFileSync, watchFile, mkdirSync, unwatchFile} from 'node:fs';
import path from 'node:path';
import {randomUUID, randomInt} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {
  nip19,
  nip44,
  generateSecretKey,
  getPublicKey,
  Event as NostrEvent,
  UnsignedEvent,
  verifyEvent,
  finalizeEvent,
  getEventHash,
  SimplePool,
  Relay,
} from 'nostr-tools';
import {SubCloser, useWebSocketImplementation} from 'nostr-tools/pool';
import {WebSocket} from 'ws';
import {normalizeURL} from 'nostr-tools/utils';
import {Subscription} from 'nostr-tools/abstract-relay';

const EphemeralGiftWrapKind = 21059;
const SealKind = 13;
const HttpRequestKind = 80;
const HttpResponseKind = 81;

function writeFile(filename: string, payload: string): void {
  const dirname = path.dirname(filename);
  if (!existsSync(dirname)) {
    mkdirSync(dirname, {recursive: true});
  }
  writeFileSync(filename, payload);
}

interface ReadWriteSecretKeyOptions {
  nsecFile: string;
  saveNsec?: boolean;
}

function readWriteSecretKey({nsecFile, saveNsec}: ReadWriteSecretKeyOptions): Uint8Array {
  if (existsSync(nsecFile)) {
    const existingSecretKey = nip19.decode(readFileSync(nsecFile).toString().trim());
    if (existingSecretKey.type !== 'nsec') {
      throw new Error('Unexpected private key format');
    }
    return existingSecretKey.data;
  }
  if (!saveNsec) {
    throw new Error('nsec-file not found');
  }
  const secretKey = generateSecretKey();
  console.info('Saving nsec-file');
  writeFile(nsecFile, nip19.nsecEncode(secretKey));
  return secretKey;
}

interface ReadWriteRelaysOptions {
  relays?: string[];
  relaysFile?: string;
  destination?: string;
}

function _readWriteRelays({relays, relaysFile, destination}: ReadWriteRelaysOptions): string[] {
  if (relaysFile && existsSync(relaysFile)) {
    const relaysFromFile = readFileSync(relaysFile).toString().split(/\s+/).filter(Boolean);
    if (relaysFromFile.length > 0) {
      return relaysFromFile;
    }
  }
  // Support both an array of relays or a single string of relays separated by spaces.
  const relaysFromOption = relays ? ([] as string[]).concat(...relays.map(r => r.split(' '))) : [];
  if (relaysFromOption.length > 0 && relaysFile) {
    writeFile(relaysFile, relaysFromOption.join('\n'));
  }
  if (!destination) {
    return relaysFromOption;
  }
  const decodedDestination = nip19.decode(destination);
  if (decodedDestination.type !== 'nprofile') {
    return relaysFromOption;
  }
  const profileRelays = (decodedDestination.data.relays ?? []).filter(relay => !relaysFromOption.includes(relay));
  return [...relaysFromOption, ...profileRelays];
}

function readWriteRelays(options: ReadWriteRelaysOptions): string[] {
  const allRelays = _readWriteRelays(options).map(normalizeURL);
  return allRelays.filter((relay, index) => index === allRelays.indexOf(relay));
}

function getPublicKeyFromDestination(destination: string): string {
  const decodedDestination = nip19.decode(destination);
  if (decodedDestination.type === 'nprofile') {
    return decodedDestination.data.pubkey;
  }
  if (decodedDestination.type === 'npub') {
    return decodedDestination.data;
  }
  throw Error('Destination type must be nprofile or npub');
}

interface RelayStatus {
  relay: string;
  isConnected: boolean;
}

async function getRelaysStatuses(pool: SimplePool, relayUrls: string[]): Promise<RelayStatus[]> {
  const allRelays = await Promise.all(relayUrls.map(relayUrl => pool.ensureRelay(relayUrl)));
  return allRelays.map(relay => ({
    relay: relay.url,
    isConnected: relay.connected,
  }));
}

interface RequestMessage {
  id: string;
  partIndex: number;
  parts: number;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBase64: string;
}

interface ResponseMessage {
  id: string;
  partIndex: number;
  parts: number;
  status?: number;
  headers?: Record<string, string>;
  bodyBase64: string;
}

interface PendingResponse {
  responseMessages: Map<number, ResponseMessage>;
  timeout: NodeJS.Timeout;
  response: http.ServerResponse<http.IncomingMessage>;
  onClose: () => void;
}

interface CachedRelay {
  relay: Relay;
  subscription: Subscription;
  requestIds: Set<string>;
}

export interface RunServerOptions extends ReadWriteRelaysOptions {
  verbose?: boolean;
  nodejsHttpOptions: string;
  port?: string;
  host?: string;
  backlog?: string;
  exclusive?: string;
  relays?: string[];
  relaysFile?: string;
  keepHost?: boolean;
  nsecFile?: string;
  saveNsec?: boolean;
  timeout?: string;
  destination?: string;
  maxCachedRelays?: string;
  exitOnFileChange?: boolean;
}

export async function runServer(options: RunServerOptions) {
  const verboseLog = options.verbose ? (t: string) => console.info(t) : () => {};
  verboseLog('Installing WebSockets');
  useWebSocketImplementation(WebSocket);

  const fixedDestinationPublicKey = options.destination && getPublicKeyFromDestination(options.destination);
  verboseLog(`Fixed destination: ${fixedDestinationPublicKey}`);
  const secretKey = options.nsecFile
    ? readWriteSecretKey({
        nsecFile: options.nsecFile,
        saveNsec: options.saveNsec,
      })
    : generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  verboseLog(`Public key: ${publicKey}`);

  let oldestTime = Date.now() / 1000;
  const handledResponseIds = new Map<string, number>();
  const intervals = [
    setInterval(() => {
      oldestTime = Date.now() / 1000 - 60; // up to 1 minute delay
      for (const [requestId, requestTime] of [...handledResponseIds.entries()]) {
        if (requestTime < oldestTime) {
          handledResponseIds.delete(requestId);
        }
      }
    }, 600_000),
  ];
  const initialRelayUrls = readWriteRelays(options);
  let pool: SimplePool | undefined;
  let poolSubscription: SubCloser | undefined;

  let cachedRelays: CachedRelay[] = [];
  const maxCachedRelays = Number(options.maxCachedRelays);
  const cleanupCachedRelays = () => {
    if (options.verbose) {
      verboseLog(
        `cleanupCachedRelays: ${JSON.stringify(
          cachedRelays.map(({relay, requestIds}) => ({
            relay: relay.url,
            requestIds: [...requestIds],
          }))
        )}`
      );
    }
    while (cachedRelays.length > maxCachedRelays) {
      const unusedRelay = cachedRelays.find(({requestIds}) => requestIds.size === 0);
      if (!unusedRelay) {
        break;
      }
      try {
        unusedRelay.relay.close();
      } catch (error) {
        console.error(`Failed to close cached relay: ${unusedRelay.relay.url}`, error);
      }
      cachedRelays = cachedRelays.filter(cachedRelay => cachedRelay !== unusedRelay);
    }
  };

  const handledEventTimes = new Map<string, number>();
  const pendingResponses: Map<string, PendingResponse> = new Map();

  const onevent = async (responseEvent: NostrEvent): Promise<void> => {
    handledEventTimes.set(responseEvent.id, responseEvent.created_at);
    try {
      verboseLog(`${responseEvent.id}: Received event: ${JSON.stringify(responseEvent)}`);
      if (responseEvent.kind !== EphemeralGiftWrapKind) {
        return;
      }
      let responseMessage: ResponseMessage;
      let responseSeal: NostrEvent;
      try {
        const decryptedSeal = nip44.decrypt(
          responseEvent.content,
          nip44.getConversationKey(secretKey, responseEvent.pubkey)
        );
        verboseLog(`${responseEvent.id}: Decrypted seal: ${JSON.stringify(decryptedSeal)}`);
        responseSeal = JSON.parse(decryptedSeal);
        if (responseSeal.kind !== SealKind) {
          return;
        }
        if (!verifyEvent(responseSeal)) {
          verboseLog(`${responseEvent.id}: Unverified event`);
          return;
        }
        const decryptedContent = nip44.decrypt(
          responseSeal.content,
          nip44.getConversationKey(secretKey, responseSeal.pubkey)
        );
        verboseLog(`${responseEvent.id}: Decrypted content: ${JSON.stringify(decryptedContent)}`);
        const unsignedResponse: Omit<NostrEvent, 'sig'> = JSON.parse(decryptedContent);
        if (unsignedResponse.kind !== HttpResponseKind) {
          return;
        }
        if (unsignedResponse.pubkey !== responseSeal.pubkey) {
          verboseLog(`${responseEvent.id}: Invalid pubkey`);
          return;
        }
        if (
          typeof unsignedResponse.created_at !== 'number' ||
          typeof unsignedResponse.id !== 'string' ||
          typeof unsignedResponse.content !== 'string'
        ) {
          verboseLog(`${responseEvent.id}: Bad format`);
          return;
        }
        if (unsignedResponse.created_at < oldestTime) {
          verboseLog(`${responseEvent.id}: Old event`);
          return;
        }
        if (Date.now() / 1000 + 600 < unsignedResponse.created_at) {
          verboseLog(`${responseEvent.id}: Future event`);
          return;
        }
        if (handledResponseIds.has(unsignedResponse.id)) {
          verboseLog(`${responseEvent.id}: Handled event`);
          return;
        }
        handledResponseIds.set(unsignedResponse.id, unsignedResponse.created_at);
        responseMessage = JSON.parse(unsignedResponse.content);
        if (!responseMessage || typeof responseMessage !== 'object') {
          throw new Error('Unexpected content type');
        }
        const {id, partIndex, parts, status, headers, bodyBase64} = responseMessage;
        if (!id || typeof id !== 'string' || id.length > 100) {
          throw new Error('Unexpected type for field: id');
        }
        if (!Number.isSafeInteger(partIndex) || partIndex < 0) {
          throw new Error('Unexpected type for field: partIndex');
        }
        if (!Number.isSafeInteger(parts) || parts < 1) {
          throw new Error('Unexpected type for field: partIndex');
        }
        if (typeof bodyBase64 !== 'string') {
          throw new Error('Unexpected type for field: bodyBase64');
        }
        if (partIndex === 0) {
          if (!Number.isSafeInteger(status)) {
            throw new Error('Unexpected type for field: status');
          }
          if (!headers || typeof headers !== 'object' || Object.values(headers).some(v => typeof v !== 'string')) {
            throw new Error('Unexpected type for field: headers');
          }
        }
      } catch (err) {
        console.error('Failed to handle event', err);
        return;
      }
      const logPrefix = `${responseEvent.id}:${JSON.stringify(responseMessage.id)}:${responseMessage.partIndex}/${responseMessage.parts}`;
      console.info(`${logPrefix}: ${nip19.npubEncode(responseSeal.pubkey)} ${JSON.stringify(responseMessage.status)}`);
      const responseFullId = `${responseMessage.id}:${responseSeal.pubkey}`;
      const pendingResponse = pendingResponses.get(responseFullId);
      if (!pendingResponse) {
        verboseLog(`${logPrefix}: No pending response`);
        return;
      }
      pendingResponse.responseMessages.set(responseMessage.partIndex, responseMessage);
      if (pendingResponse.responseMessages.size < responseMessage.parts) {
        return;
      }
      pendingResponses.delete(responseFullId);
      clearTimeout(pendingResponse.timeout);
      try {
        const firstResponseMessage = pendingResponse.responseMessages.get(0);
        if (!firstResponseMessage) {
          throw new Error('Malformed response sequence');
        }
        let body: Buffer;
        try {
          body = Buffer.from(
            Array.from({length: responseMessage.parts})
              .map((_, index) => pendingResponse.responseMessages.get(index)?.bodyBase64 ?? '')
              .join(''),
            'base64'
          );
        } catch (error) {
          console.error(`${logPrefix}: malformed base64 body sequence`, error);
          throw new Error('Malformed base64 body sequence');
        }
        pendingResponse.response.writeHead(
          firstResponseMessage.status!,
          typeof firstResponseMessage.headers === 'object' ? firstResponseMessage.headers : {}
        );
        pendingResponse.response.end(body);
      } catch (error) {
        console.error(`${logPrefix}: failed to send response`, error);
      }
      pendingResponse.onClose();
    } catch (error) {
      console.error(`Failed to handle event ${responseEvent.id}`, error);
    }
  };
  const subscriptionParams = {
    alreadyHaveEvent: (eventId: string) => handledEventTimes.has(eventId),
    onevent,
  };

  const poolSubscribe = (since: number) =>
    pool?.subscribeMany(
      initialRelayUrls,
      [
        {
          since,
          kinds: [EphemeralGiftWrapKind],
          '#p': [publicKey],
        },
      ],
      subscriptionParams
    );

  intervals.push(
    setInterval(() => {
      const since = Math.ceil(Date.now() / 1000) - 48 * 3600;
      const newSubsription = poolSubscribe(since);
      poolSubscription?.close();
      poolSubscription = newSubsription;
      for (const cachedRelay of cachedRelays) {
        const newRelaySubscription = cachedRelay.relay.subscribe(
          [
            {
              since,
              kinds: [EphemeralGiftWrapKind],
              '#p': [publicKey],
            },
          ],
          subscriptionParams
        );
        cachedRelay.subscription.close();
        cachedRelay.subscription = newRelaySubscription;
      }
      for (const [eventId, eventTime] of [...handledEventTimes.entries()]) {
        if (eventTime < since) {
          handledEventTimes.delete(eventId);
        }
      }
    }, 3_600_000)
  );

  if (initialRelayUrls.length > 0) {
    pool = new SimplePool();
    verboseLog('Connecting to initial relays');
    poolSubscription = poolSubscribe(Math.ceil(Date.now() / 1000) - 48 * 3600);

    await sleep(1000);
    let relaysStatuses = await getRelaysStatuses(pool, initialRelayUrls);
    if (relaysStatuses.every(status => !status.isConnected)) {
      // wait some more
      await sleep(5000);
      relaysStatuses = await getRelaysStatuses(pool, initialRelayUrls);
      if (relaysStatuses.every(status => !status.isConnected)) {
        console.error('Failed to connect to any of the relays.');
        throw new Error('Failed to connect to any of the relays.');
      }
    }
    if (options.verbose) {
      console.table(relaysStatuses);
    } else {
      console.info(`Connected to ${relaysStatuses.filter(w => w.isConnected).length}/${relaysStatuses.length} relays.`);
    }
  }
  const server = http.createServer(JSON.parse(options.nodejsHttpOptions), async (req, res) => {
    const id = randomUUID();
    let hintRelays: string[] = [];

    console.info(`${id}: ${req.socket.localAddress}: ${req.method} ${req.url}`);
    const headers = {...req.headers};
    if (!options.keepHost) {
      delete headers.host;
    }
    let destinationPublicKey: string;
    if (fixedDestinationPublicKey) {
      destinationPublicKey = fixedDestinationPublicKey;
    } else {
      const nostrDestinationHeader = `${headers['x-nostr-destination'] ?? ''}`;
      delete headers['x-nostr-destination'];
      verboseLog(`${id}: X-Nostr-Destination: ${JSON.stringify(nostrDestinationHeader)}`);
      if (!nostrDestinationHeader) {
        res.writeHead(400);
        res.end('Missing X-Nostr-Destination header');
        return;
      }
      try {
        if (nostrDestinationHeader.startsWith('nprofile')) {
          const decodedDestination = nip19.decode(nostrDestinationHeader);
          if (decodedDestination.type !== 'nprofile') {
            throw new Error('Unexpected X-Nostr-Destination header');
          }
          destinationPublicKey = decodedDestination.data.pubkey;
          hintRelays = (decodedDestination.data.relays ?? [])
            .map(normalizeURL)
            .filter(hintRelay => !initialRelayUrls.includes(hintRelay));
          if (hintRelays.length === 0 && initialRelayUrls.length === 0) {
            res.writeHead(400);
            res.end(
              'The server does not have default relays. The given X-Nostr-Destination is indeed a\
   NIP19 nprofile entity, but it does not have any hints for relays.'
            );
          }
          for await (const relayUrl of hintRelays) {
            const existingRelay = cachedRelays.find(({relay}) => relay.url === relayUrl);
            if (existingRelay) {
              verboseLog(`Using existing cached relay: ${JSON.stringify(relayUrl)}`);
              existingRelay.requestIds.add(id);
              cachedRelays = [...cachedRelays.filter(cachedRelay => cachedRelay !== existingRelay), existingRelay];
            } else {
              try {
                verboseLog(`Connecting to new relay: ${JSON.stringify(relayUrl)}`);
                const newRelay = await Relay.connect(relayUrl);
                const newSubscription = newRelay.subscribe(
                  [
                    {
                      since: Math.ceil(Date.now() / 1000) - 48 * 3600,
                      kinds: [EphemeralGiftWrapKind],
                      '#p': [publicKey],
                    },
                  ],
                  subscriptionParams
                );
                cachedRelays = [
                  ...cachedRelays,
                  {
                    relay: newRelay,
                    subscription: newSubscription,
                    requestIds: new Set([id]),
                  },
                ];
                cleanupCachedRelays();
              } catch (error) {
                console.error(`${id}: Failed to connect to relay ${JSON.stringify(relayUrl)}`, error);
              }
            }
          }
        } else if (initialRelayUrls.length > 0) {
          destinationPublicKey = getPublicKeyFromDestination(nostrDestinationHeader);
        } else {
          res.writeHead(400);
          res.end(
            'The server does not have default relays. X-Nostr-Destination header must be a NIP19\
 nprofile entity that has hints for relays.'
          );
          return;
        }
      } catch (error) {
        console.error(
          `${id}: Failed to parse x-nostr-destination header: ${JSON.stringify(nostrDestinationHeader)}`,
          error
        );
        res.writeHead(400);
        res.end('Malformed header: X-Nostr-Destination');
        return;
      }
    }
    const fullId = `${id}:${destinationPublicKey}`;
    // TODO: create new pending response and publish request.

    const onClose = () => {
      let requestIdFound = false;
      for (const relay of cachedRelays) {
        if (relay.requestIds.has(id)) {
          relay.requestIds.delete(id);
          requestIdFound = true;
        }
      }
      if (requestIdFound) {
        cleanupCachedRelays();
      }
    };

    pendingResponses.set(fullId, {
      responseMessages: new Map(),
      timeout: setTimeout(() => {
        console.error(`${fullId}: Request timed out`);
        try {
          res.writeHead(500);
          res.end('Timed out');
        } catch (error) {
          console.error(`${fullId}: failed to write timeout response`, error);
        }
        onClose();
      }, Number(options.timeout)),
      response: res,
      onClose,
    });

    const bodyChunks: Buffer[] = [];
    req.on('data', chunk => {
      bodyChunks.push(chunk);
    });
    req.on('end', async () => {
      try {
        const bodyBase64 = Buffer.concat(bodyChunks).toString('base64');
        const bodyBase64Chunks: [string, number][] = [];
        if (bodyBase64 === '') {
          bodyBase64Chunks.push(['', 0]);
        } else {
          for (let partIndex = 0; partIndex * 32768 < bodyBase64.length; partIndex += 1) {
            bodyBase64Chunks.push([bodyBase64.slice(partIndex * 32768, (partIndex + 1) * 32768), partIndex]);
          }
        }
        for (const [bodyBase64Chunk, partIndex] of bodyBase64Chunks) {
          const logPrefix = `${fullId}:${partIndex}:${bodyBase64Chunks.length}`;
          const requestMessage: RequestMessage = {
            id,
            partIndex,
            parts: bodyBase64Chunks.length,
            bodyBase64: bodyBase64Chunk,
            ...(partIndex === 0 && {
              headers: Object.fromEntries(
                Object.entries(headers).map(([headerName, headerValue]) => [
                  headerName,
                  Array.isArray(headerValue) ? headerValue[0] : headerValue ?? '',
                ])
              ),
              method: req.method ?? '',
              url: req.url ?? '',
            }),
          };
          const stringifiedRequestMessage = JSON.stringify(requestMessage);
          verboseLog(`${logPrefix}: Sending request: ${stringifiedRequestMessage}`);
          const now = Math.floor(Date.now() / 1000);
          const unsignedRequest: UnsignedEvent = {
            kind: HttpRequestKind,
            tags: [],
            content: stringifiedRequestMessage,
            created_at: now,
            pubkey: publicKey,
          };
          const finalUnsignedRequestStringified = JSON.stringify({
            ...unsignedRequest,
            id: getEventHash(unsignedRequest),
          });
          verboseLog(`${logPrefix}: final unsigned request: ${finalUnsignedRequestStringified}`);
          const requestSeal = finalizeEvent(
            {
              created_at: now - randomInt(0, 48 * 3600),
              kind: SealKind,
              tags: [],
              content: nip44.encrypt(
                finalUnsignedRequestStringified,
                nip44.getConversationKey(secretKey, destinationPublicKey)
              ),
            },
            secretKey
          );
          verboseLog(`${logPrefix}: request seal: ${JSON.stringify(requestSeal)}`);
          const randomPrivateKey = generateSecretKey();
          verboseLog(`${logPrefix}: random public key: ${getPublicKey(randomPrivateKey)}`);
          const safeRelays = [...initialRelayUrls, ...hintRelays].filter(relay => {
            const parsedRelay = new URL(relay);
            // Don't publish relay addresses that might contain sensitive information
            return !parsedRelay.username && !parsedRelay.password && !parsedRelay.search;
          });
          const requestEvent = finalizeEvent(
            {
              created_at: now,
              kind: EphemeralGiftWrapKind,
              tags: [
                ['p', destinationPublicKey, ...safeRelays.slice(0, 1)],
                ...(safeRelays.length > 1 ? [['relays', ...safeRelays.slice(1)]] : []),
              ],
              content: nip44.encrypt(
                JSON.stringify(requestSeal),
                nip44.getConversationKey(randomPrivateKey, destinationPublicKey)
              ),
            },
            randomPrivateKey
          );
          verboseLog(`${logPrefix}: publishing request event: ${JSON.stringify(requestEvent)}`);
          // Ugly code, but its the only way I found to log which relay caused the problem.
          await Promise.all(
            initialRelayUrls.map(async initialRelayUrl => {
              if (!pool) {
                return;
              }
              try {
                verboseLog(`${logPrefix}: publishing to pool relay ${initialRelayUrl}`);
                await Promise.all(pool.publish([initialRelayUrl], requestEvent));
              } catch (error) {
                console.error(`${logPrefix}: Failed to publish request to initial relay ${initialRelayUrl}`, error);
              }
            })
          );
          // Publishing to all cached relays, not only the hint relays.
          for (const relay of cachedRelays) {
            try {
              verboseLog(`${logPrefix}: publishing to cached relay ${relay.relay.url}`);
              await relay.relay.publish(requestEvent);
            } catch (error) {
              console.error(`${logPrefix}: failed to publish request to realy ${relay.relay.url}`, error);
            }
          }
          console.info(`${logPrefix}: done`);
        }
      } catch (err) {
        console.error('Failed to send nostr message:', err);
        res.writeHead(500);
        res.end('Failed');
      }
    });
  });

  server.listen(
    {
      port: Number(options.port),
      host: options.host,
      backlog: options.backlog,
      exclusive: options.exclusive,
    },
    () => {
      console.info('Started listening on port:', options.port);
    }
  );
  const exit = () => {
    setTimeout(() => {
      console.error('Failed to close connections after 10 seconds');
      process.exit(-1);
    }, 10_000).unref();
    if (pool) {
      pool.close(initialRelayUrls);
      pool = undefined;
    }
    for (const cachedRelay of cachedRelays) {
      cachedRelay.relay.close();
    }
    for (const filename of [options.nsecFile, options.relaysFile]) {
      if (filename) {
        unwatchFile(filename);
      }
    }
    for (const interval of intervals) {
      clearInterval(interval);
    }
    server.close();
    server.closeAllConnections();
  };
  if (options.exitOnFileChange) {
    if (options.nsecFile) {
      watchFile(options.nsecFile, () => {
        console.info('Exiting due to nsec-file change:', options.nsecFile);
        exit();
      });
    }
    if (options.relaysFile) {
      watchFile(options.relaysFile, () => {
        console.info('Exiting due to relays-file change:', options.relaysFile);
        exit();
      });
    }
  }
}
