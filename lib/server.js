const http = require('node:http');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const {
  Client, Filter, Timestamp, nip04Decrypt, NostrSigner, Keys, PublicKey,
  loadWasmAsync, EventBuilder, RelayListItem,
} = require("@rust-nostr/nostr-sdk");

function readWriteKeys(nsecFile, saveNsecIfNotFound) {
  if (fs.existsSync(nsecFile)) {
    return Keys.parse(fs.readFileSync(nsecFile).toString().trim());
  }
  if (!saveNsecIfNotFound) {
    throw new Error("nsec-file not found");
  }
  const keys = Keys.generate();
  console.info("Saving nsec-file");
  fs.writeFileSync(nsecFile, keys.secretKey.toBech32());
  return keys;
}

exports.runServer = async function runServer(options) {
  const verboseLog = options.verbose ? ((t) => console.info(t)) : () => {};
  verboseLog("Loading WebAssembly");
  await loadWasmAsync();

  const fixedDestinationPublicKey = options.destination ? PublicKey.parse(options.destination) : undefined;
  const keys = (
    options.nsecFile
    ? readWriteKeys(options.nsecFile, options.saveNsec)
    : Keys.generate()
  );

  const client = new Client(NostrSigner.keys(keys));
  // Support both an array of relays or a single string of relays separated by spaces.
  const relays = [].concat(...options.relays.map(r => r.split(' ')));
  client.addRelays(relays);
  verboseLog("Connecting");
  await client.connect();

  const relaysListEvent = EventBuilder.relayList(
    relays.map(r => new RelayListItem(r)),
  ).toEvent(keys);
  verboseLog("Publishing relays");
  await client.sendEvent(relaysListEvent);

  const pendingResponses = new Map();

  const server = http.createServer(JSON.parse(options.nodejsHttpOptions), (req, res) => {
    const id = randomUUID();

    console.info(`${id}: ${req.socket.localAddress}: ${req.method} ${req.url}`);
    const headers = { ...req.headers };
    if (!options.keepHost) {
      delete headers.host;
    }
    let destinationPublicKey;
    if (fixedDestinationPublicKey) {
      destinationPublicKey = fixedDestinationPublicKey;
    } else {
      const nostrDestinationHeader = headers['x-nostr-destination'];
      delete headers['x-nostr-destination'];
      if (!nostrDestinationHeader) {
        res.writeHead(400);
        res.end('Missing X-Nostr-Destination header');
        return;
      }
      try {
        destinationPublicKey = PublicKey.parse(`${nostrDestinationHeader}`);
      } catch (error) {
        console.error(
          `${id}: Failed to parse x-nostr-destination header: ${
            JSON.stringify(nostrDestinationHeader)
          }`,
        );
        res.writeHead(400);
        res.end("Malformed header: X-Nostr-Destination");
        return;
      }
    }

    pendingResponses.set(id, {
      timeout: setTimeout(() => {
        console.error(`${id}: Request timed out`);
        res.writeHead(500);
        res.end('Timed out');
      }, Number(options.timeout)),
      response: res,
    });
    res.on('close', () => {
      const wrapper = pendingResponses.get(id);
      if (wrapper) {
        verboseLog(`${id}: Deleting pending response`);
        clearTimeout(wrapper.timeout);
        pendingResponses.delete(id);
      }
    });

    const bodyChunks = [];
    req.on('data', (chunk) => {
      bodyChunks.push(chunk);
    });
    req.on('end', async () => {
      try {
        await client.sendDirectMsg(destinationPublicKey, JSON.stringify({
          id,
          headers,
          method: req.method,
          url: req.url,
          bodyBase64: Buffer.concat(bodyChunks).toString('base64'),
        }));
      } catch (err) {
        console.error("Failed to send nostr message:", err);
        res.writeHead(500);
        res.end("Failed");
      }
    });
  });

  const filter = new Filter().pubkey(keys.publicKey).kind(4).since(Timestamp.now());

  client.handleNotifications({
    handleEvent: async (relayUrl, subscriptionId, event) => {
      verboseLog(`Event: ${event.asJson()}`);
      if (event.kind !== 4) {
        return;
      }
      try {
          const content = nip04Decrypt(keys.secretKey, event.author, event.content);
          verboseLog(`NIP04 Message: ${content}`);
          const parsedContent = JSON.parse(content);
          const requestId = `${parsedContent.id}`.slice(0, 100);
          const wrapper = pendingResponses.get(requestId);
          if (!wrapper) {
            console.error("Could not find reponse for id", requestId);
            throw new Error("Unknown id not found");
          }
          wrapper.response.writeHead(
            parsedContent.status,
            typeof parsedContent.headers === 'object' ? parsedContent.headers : {},
          );
          wrapper.response.end(Buffer.from(parsedContent.bodyBase64, 'base64'));
      } catch (err) {
          console.error("Impossible to handle DM:", err);
      }
    },
    handleMsg: async (relayUrl, message) => {}
  })
  await client.subscribe([filter]);


  server.listen({
    port: Number(options.port),
    host: options.host,
    backlog: options.backlog,
    exclusive: options.exclusive,
  }, () => {
    console.info(`Started listening on port ${options.port}`);
  });
};
