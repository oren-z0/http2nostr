# http2nostr
A simple http proxy that forwards all requests as nostr direct-messages.

Execute directly with npx: `npx http2nostr [options] <destination>`.
Alternatively, you can install http2nostr globally with: `npm i -g http2nostr`, and then run `http2nostr [options] <destination>` directly.

For example:
```
npx http2nostr --verbose --nsec-file ~/my-nsec.txt --save-nsec --relays wss://relay.damus.io wss://nos.lol wss://relay.snort.social wss://nostr.wine -p 8080 <server-npub>
```

```
$ npx http2nostr --help

Usage: http2nostr [options]

A simple http proxy that forwards all requests as nostr direct-messages.

Options:
  -V, --version                    output the version number
  --nodejs-http-options [options]  A json object of options for the http.createServer function (see:
                                   https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener). (default: "{}")
  -p, --port <port>                Port to listen
  -h, --host <host>                Host to listen
  --backlog <backlog>              Backlog (see: https://nodejs.org/api/net.html#serverlisten)
  --exclusive <exclusive>          Exclusive (see: https://nodejs.org/api/net.html#serverlisten)
  --relays <relays...>             A list of relays to use for the nostr direct-messages.
  --keep-host                      Keep the Host header of the http request (by default it is removed).
  --nsec-file <filename>           Send nostr message from this nsec (by default generate a random nsec on each execution)
  --save-nsec                      If the nsec file was not found, generate a random nsec and save it in the same path.
  --timeout <timeout>              Timeout in milliseconds (default: 300000)
  --destination <destination>      All requests will be sent to this destination npub. If not defined, the requests will be sent according to the X-Nostr-Destination
                                   header (and the header is removed).
  -v, --verbose                    Verbose logs
  --help                           display help for command
```
