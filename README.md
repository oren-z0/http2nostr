# http2nostr
A simple http proxy that forwards all requests as nostr direct-messages.

**This package is very useful together with [nostr2http](https://github.com/oren-z0/nostr2http)
for accessing http servers that run in different local networks (behind
[NAT](https://en.wikipedia.org/wiki/Network_address_translation)).**

Execute directly with npx: `npx http2nostr [options]`.
Alternatively, you can install http2nostr globally with: `npm i -g http2nostr`, and then run `http2nostr [options]` directly.

For example:
```
npx http2nostr --verbose --nsec-file ~/my-nsec.txt --save-nsec --relays wss://relay.damus.io wss://nos.lol wss://relay.snort.social wss://nostr.wine -p 8080
```

```
$ npx http2nostr --help

Usage: http2nostr [options]

A simple http proxy that forwards all requests as nostr direct-messages.

Options:
  -V, --version                    output the version number
  --nodejs-http-options <options>  A json object of options for the
                                   http.createServer function (see:
                                   https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener).
                                   (default: "{}")
  -p, --port <port>                Port to listen
  -h, --host <host>                Host to listen
  --backlog <backlog>              Backlog (see:
                                   https://nodejs.org/api/net.html#serverlisten)
  --exclusive <exclusive>          Exclusive (see:
                                   https://nodejs.org/api/net.html#serverlisten)
  --relays <relays...>             A list of relays to use for the nostr
                                   direct-messages.
  --relays-file <filename>         A file to read the relays from. If both
                                   --relays and --relays-file are defined and
                                   the file exists, only the file will be used.
                                   If the file doesn't exist or empty, it will
                                   be created with the relays given in the
                                   --relays option (i.e. the --relays option
                                   represents "default relays" in this case).
                                   The relays in the file should be separated
                                   by space or new-lines.
  --keep-host                      Keep the Host header of the http request (by
                                   default it is removed).
  --nsec-file <filename>           Send nostr message from this nsec (by
                                   default generate a random nsec on each
                                   execution)
  --save-nsec                      If the nsec file was not found, generate a
                                   random nsec and save it in the same path.
  --timeout <timeout>              Timeout in milliseconds (default: "300000")
  --destination <destination>      All requests will be sent to this
                                   destination npub/nprofile. If not defined,
                                   the requests will be sent according to the
                                   X-Nostr-Destination header (and the header
                                   is removed).
  --max-cached-relays <number>     When the x-nostr-destination header is an
                                   NIP-19 nprofile, the server will attempt to
                                   connect to the relay hints in the nprofile,
                                   and will keep connections to these relays
                                   for future requests. If the number of
                                   connections crosses this limit, the server
                                   will attempt to disconnect unused
                                   connections. (default: "10")
  --exit-on-file-change            Exit when the files in --relays-file or
                                   --nsec-file change by an external process.
                                   Useful to reboot the server when those
                                   configuration change (don't forget to start
                                   the process again after it dies, using
                                   docker-compose configuration or some other
                                   way).
  -v, --verbose                    Verbose logs
  --help                           display help for command
```
