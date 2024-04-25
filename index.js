#!/usr/bin/env node
const { runServer } = require('./lib/server');

exports.runServer = runServer;

if (require.main === module) {
  const { program } = require('commander');
  program
    .name('http2nostr')
    .description('A simple http proxy that forwards all requests as nostr direct-messages.')
    .version('0.2.0')

  program
    .option(
      '--nodejs-http-options [options]',
      `A json object of options for the http.createServer function (see: \
https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener).`,
      '{}',
    )
    .requiredOption('-p, --port <port>', 'Port to listen')
    .option('-h, --host <host>', 'Host to listen')
    .option('--backlog <backlog>', 'Backlog (see: https://nodejs.org/api/net.html#serverlisten)')
    .option(
      '--exclusive <exclusive>',
      'Exclusive (see: https://nodejs.org/api/net.html#serverlisten)',
    )
    .requiredOption(
      '--relays <relays...>',
      'A list of relays to use for the nostr direct-messages.',
    )
    .option('--keep-host', 'Keep the Host header of the http request (by default it is removed).')
    .option(
      '--nsec-file <filename>',
      'Send nostr message from this nsec (by default generate a random nsec on each execution)',
    )
    .option(
      '--save-nsec',
      'If the nsec file was not found, generate a random nsec and save it in the same path.',
    )
    .option('--timeout <timeout>', 'Timeout in milliseconds', 300000)
    .option(
      '--destination <destination>',
      'All requests will be sent to this destination npub. If not defined, the requests will be\
 sent according to the X-Nostr-Destination header (and the header is removed).',
    )
    .option('-v, --verbose', 'Verbose logs')
    .parse();

  runServer(program.opts());
}

