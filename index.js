#!/usr/bin/env node
const { runServer } = require('./lib/server');

exports.runServer = runServer;

if (require.main === module) {
  const { program } = require('commander');
  const { version } = require('./package');
  program
    .name('http2nostr')
    .description('A simple http proxy that forwards all requests as nostr direct-messages.')
    .version(version)

  program
    .option(
      '--nodejs-http-options <options>',
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
    .option(
      '--relays <relays...>',
      'A list of relays to use for the nostr direct-messages.',
    )
    .option(
      '--relays-file <filename>',
      'A file to read the relays from. If both --relays and --relays-file are defined and the file\
 exists, only the file will be used. If the file doesn\'t exist or empty, it will be created with\
 the relays given in the --relays option (i.e. the --relays option represents "default relays" in\
 this case). The relays in the file should be separated by space or new-lines.',
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
    .option(
      '--exit-on-file-change',
      'Exit when the files in --relays-file or --nsec-file change by an external process. Useful\
 to reboot the server when those configuration change (don\'t forget to start the process again\
 after it dies, using docker-compose configuration or some other way).',
    )
    .option('-v, --verbose', 'Verbose logs')
    .parse();

  runServer(program.opts());
}

