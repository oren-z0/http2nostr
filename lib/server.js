const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const process = require('node:process');
const {
  Client, Filter, Timestamp, nip04Decrypt, NostrSigner, Keys, PublicKey,
  loadWasmAsync, Nip19Profile
} = require("@rust-nostr/nostr-sdk");

function writeFile(filename, payload) {
  const dirname = path.dirname(filename);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname);
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
  if (relaysFromOption.length === 0) {
    throw new Error(
      "Missing --relays option, or a --relays-file option that points to a non-empty file",
    );
  }
  if (relaysFile) {
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
  const relays = readWriteRelays(options);

  await client.addRelays(relays);
  verboseLog(`Connecting to relays: ${relays.join(' ')}`);
  await client.connect();

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
