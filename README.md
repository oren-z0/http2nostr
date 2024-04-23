# http2nostr
A simple http proxy that forwards all requests as nostr direct-messages.

Execute directly with npx: `npx http2nostr -- [options] <destination>`.

For example:
```
npx http2nostr -- --verbose --nsec-file ~/my-nsec.txt --save-nsec --relays wss://relay.damus.io wss://nos.lol wss://relay.snort.social wss://nostr.wine -p 8080 <server-npub>
```

```
Usage: http2nostr [options] <destination>

A simple http proxy that forwards all requests as nostr direct-messages.

Arguments:
  destination                      Destination npub

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
  -v, --verbose                    Verbose logs
  --help                           display help for command
```
