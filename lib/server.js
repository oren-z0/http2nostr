const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const process = require('node:process');
const { setTimeout: sleep } = require('node:timers/promises');
const {
  Client, Filter, Timestamp, nip04Decrypt, NostrSigner, Keys, PublicKey,
  loadWasmAsync, Nip19Profile
} = require("@rust-nostr/nostr-sdk");
const pLimit = require('p-limit');

function writeFile(filename, payload) {
  const dirname = path.dirname(filename);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
  fs.writeFileSync(filename, payload);
}

function readWriteKeys(nsecFile, saveNsecIfNotFound) {
  if (fs.existsSync(nsecFile)) {
    return Keys.parse(fs.readFileSync(nsecFile).toString().trim());
  }
  if (!saveNsecIfNotFound) {
    throw new Error("nsec-file not found");
  }
  const keys = Keys.generate();
  console.info("Saving nsec-file");
  writeFile(nsecFile, keys.secretKey.toBech32());
  return keys;
}

function readWriteRelays({ relays, relaysFile, destination }) {
  if (relaysFile && fs.existsSync(relaysFile)) {
    const relaysFromFile = fs.readFileSync(relaysFile).toString().split(/\s+/).filter(Boolean);
    if (relaysFromFile.length > 0) {
      return relaysFromFile;
    }
  }
  // Support both an array of relays or a single string of relays separated by spaces.
  const relaysFromOption = relays ? [].concat(...relays.map(r => r.split(' '))) : [];
  if (relaysFromOption.length > 0 && relaysFile) {
    writeFile(relaysFile, relaysFromOption.join('\n'));
  }
  if (!destination?.startsWith('nprofile')) {
    return relaysFromOption;
  }
  const profileRelays = Nip19Profile.fromBech32(destination).relays().filter(
    relay => !relaysFromOption.includes(relay),
  );
  return [
    ...relaysFromOption,
    ...profileRelays,
  ];
}

function getPublicKey(destination) {
  if (!destination) {
    return undefined;
  }
  if (destination.startsWith('nprofile')) {
    return Nip19Profile.fromBech32(destination).publicKey();
  }
  return PublicKey.parse(destination)
}

async function getRelaysStatuses(client) {
  const allRelays = await client.relays();
  return await Promise.all(
    allRelays.map(async (relay) => ({
      relay: relay.url(),
      isConnected: await relay.isConnected(),
    })),
  );
}

exports.runServer = async function runServer(options) {
  const verboseLog = options.verbose ? ((t) => console.info(t)) : () => {};
  verboseLog("Loading WebAssembly");
  await loadWasmAsync();

  const fixedDestinationPublicKey = getPublicKey(options.destination);
  const keys = (
    options.nsecFile
    ? readWriteKeys(options.nsecFile, options.saveNsec)
    : Keys.generate()
  );

  const client = new Client(NostrSigner.keys(keys));
  const initialRelayUrls = readWriteRelays(options);

  if (initialRelayUrls.length > 0) {
    await client.addRelays(initialRelayUrls);
    await client.connect();
    await sleep(1000);
    let relaysStatuses = await getRelaysStatuses(client);
    if (relaysStatuses.every(status => !status.isConnected)) {
      // wait some more
      await sleep(5000);
      relaysStatuses = await getRelaysStatuses(client);
    }
    if (options.verbose) {
      console.table(relaysStatuses);
    } else {
      console.info(`Connected to ${
        relaysStatuses.filter(w => w.isConnected).length
      }/${relaysStatuses.length} relays.`);
    }
  } else {
    verboseLog("No relays to connect.");
  }

  let cachedRelays = [];
  const maxCachedRelays = Number(options.maxCachedRelays);
  const addHintRelayPLimit = pLimit(1);
  const addHintRelay = (relayUrl) => addHintRelayPLimit(async () => {
    const isNew = await client.addRelay(relayUrl);
    const normalizedUrl = (await client.relay(relayUrl)).url();
    if (!isNew) {
      const otherCachedRelays = cachedRelays.filter(someUrl => someUrl !== normalizedUrl);
      if (otherCachedRelays.length < cachedRelays.length) {
        // This is a new hint relay and was not in the default relays list.
        cachedRelays = [
          ...otherCachedRelays,
          normalizedUrl,
        ];  
      }
      return { normalizedUrl, isNew };
    }
    cachedRelays.push(normalizedUrl);
    while (cachedRelays.length > maxCachedRelays) {
      const [relayToRemove] = cachedRelays;
      verboseLog(`Disconnecting from a cached relay: ${relayToRemove}`);
      await client.disconnectRelay(relayToRemove);
      await client.removeRelay(relayToRemove);
      cachedRelays.shift();
    }
    return { normalizedUrl, isNew };
  });
  

  const pendingResponses = new Map();

  const server = http.createServer(JSON.parse(options.nodejsHttpOptions), async (req, res) => {
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
          const hintRelays = Nip19Profile.fromBech32(nostrDestinationHeader).relays();
          if (hintRelays.length === 0 && initialRelayUrls.length === 0) {
            res.writeHead(400);
            res.end(
              "The server does not have default relays. The given X-Nostr-Destination is indeed a\
   NIP19 nprofile entity, but it does not have any hints for relays.",
            );
          }
          const newUrls = [];
          const existingUrls = [];
          for await (const relayUrl of hintRelays) {
            const { normalizedUrl, isNew } = await addHintRelay(relayUrl);
            if (isNew) {
              newUrls.push(normalizedUrl);
            } else {
              existingUrls.push(normalizedUrl);
            }
          }
          if (newUrls.length > 0) {
            verboseLog(`Connecting to new relays: ${JSON.stringify(newUrls)}`);
            await client.connect();
            await sleep(1000);
            const newStatuses = await getRelaysStatuses(client);
            verboseLog(`Currently connected relays: ${
              newStatuses.map(s => `${s.relay}: ${s.isConnected}`).join(', ')
            }`);
            const statusMap = new Map(newStatuses.map((w) => [w.relay, w.isConnected]));
            if ([...existingUrls, ...newUrls].every(u => !statusMap.get(u))) {
              // wait more
              await sleep(5000);
            }
          }
        } else if (initialRelayUrls.length == 0) {
          res.writeHead(400);
          res.end(
            "The server does not have default relays. X-Nostr-Destination header must be a NIP19\
 nprofile entity that has hints for relays.",
          );
          return;
        }
        destinationPublicKey = getPublicKey(nostrDestinationHeader);
      } catch (error) {
        console.error(
          `${id}: Failed to parse x-nostr-destination header: ${
            JSON.stringify(nostrDestinationHeader)
          }`,
          error,
        );
        res.writeHead(400);
        res.end("Malformed header: X-Nostr-Destination");
        return;
      }
    }
    const fullId = `${id}:${destinationPublicKey.toBech32()}`;

    pendingResponses.set(fullId, {
      timeout: setTimeout(() => {
        console.error(`${fullId}: Request timed out`);
        res.writeHead(500);
        res.end('Timed out');
      }, Number(options.timeout)),
      response: res,
    });
    res.on('close', () => {
      const wrapper = pendingResponses.get(fullId);
      if (wrapper) {
        verboseLog(`${fullId}: Deleting pending response`);
        clearTimeout(wrapper.timeout);
        pendingResponses.delete(fullId);
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
          if (
            !parsedContent || typeof parsedContent !== 'object' ||
            !parsedContent.id || typeof parsedContent.id !== 'string' || parsedContent.id.length > 100
          ) {
            throw new Error("Malformed message id");
          }
          const requestId = `${parsedContent.id}:${event.author.toBech32()}`;
          const wrapper = pendingResponses.get(requestId);
          if (!wrapper) {
            console.error("Could not find reponse for id", requestId);
            throw new Error("Message id not found or received from unexpected origin");
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
    console.info("Started listening on port:", options.port);
  });

  if (options.exitOnFileChange) {
    if (options.nsecFile) {
      fs.watchFile(options.nsecFile, () => {
        console.info("Exiting due to nsec-file change:", options.nsecFile);
        process.exit(0);
      });
    }
    if (options.relaysFile) {
      fs.watchFile(options.relaysFile, () => {
        console.info("Exiting due to relays-file change:", options.relaysFile);
        process.exit(0);
      });
    }
  }
};
