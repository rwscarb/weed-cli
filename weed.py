#!/usr/bin/env python3
"""
weed — single CLI entry point for this repo's PoC mechanisms.

Two kinds of subcommand:

  - demo/network/stats/... — thin argparse wrapper over the Makefile, not a
    reimplementation of it. The Makefile stays the single source of truth
    for what each demo actually runs; this just gives it subcommands and
    `--help` text instead of needing to remember `make` targets.

  - host/discover/download/like/subscribe/whoami — real commands, not demo
    wrappers. These call directly into node.py and actually host a file,
    actually download one from a peer with per-chunk verification, actually
    post/read signed events from a relay. This is the integration piece —
    one tool, not six disconnected scripts.
"""
import argparse
import os
import subprocess
import sys

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, REPO_DIR)

COMMANDS = {
    'demo':         ('demo',         'possession-gated auction, narrated (Parts 1 + 2)'),
    'network':      ('network',      'real sockets, single-shot challenge rounds, loopback'),
    'stats':        ('stats',        'real sockets, repeated-challenge separation analysis'),
    'discovery':    ('discovery',    '3 real relays, personalized ranking, sybil test'),
    'reputation':   ('reputation',   'signed attestations + revocation demo'),
    'chart':        ('chart',        'regenerate the README separation chart'),
    'containers':   ('containers',   'same challenge test, real docker containers'),
    'real-archive': ('real-archive', 'challenge mechanism against a real .ott video archive'),
    'clean':        ('clean',        'remove __pycache__, tmp reputation stores'),
}

LIGHTNING_COMMANDS = {
    'up':    ('lightning-up',    'start bitcoind + 2 LND nodes on regtest'),
    'down':  ('lightning-down',  'tear down the lightning stack (drops chain state + wallets)'),
    'demo':  ('lightning-demo',  'poc_challenge_auction.py --lightning — real HTLC settlement'),
    'smoke': ('lightning-smoke', 'one real test payment via lightning_settle.py'),
}


def run_make(target):
    result = subprocess.run(['make', target], cwd=REPO_DIR)
    sys.exit(result.returncode)


# $WEED_RELAY/$WEED_TUNNEL let a real relay/tunnel deployment (not just
# the loopback defaults everything below otherwise falls back to) be set
# once per shell session instead of retyped on every host/discover/
# download/like/subscribe invocation -- an explicit --relay/--tunnel
# flag still always wins, this only changes what happens when neither is
# given. shell.py's WeedShell reads the same two variables for the same
# reason (see its own default_relay/default_tunnel).
def _default_relay():
    return os.environ.get('WEED_RELAY', 'http://127.0.0.1:9101')


def _default_relay_list():
    # --relay is action='append' on p_host specifically, which normally
    # defaults to [] (empty = "don't announce anywhere" is a valid,
    # deliberate choice there — see cmd_host) rather than falling back to
    # loopback; only seed that list from $WEED_RELAY when it's actually set
    relay = os.environ.get('WEED_RELAY')
    return [relay] if relay else []


def _default_tunnel_list():
    # --tunnel is action='append' too (see p_host): seed it from
    # $WEED_TUNNEL when set -- which may itself be comma-separated, see
    # node._split_tunnel_spec
    tunnel = os.environ.get('WEED_TUNNEL')
    return [tunnel] if tunnel else []


def build_parser():
    import node
    import lightning_settle
    ln_nodes = sorted(lightning_settle.NODES)
    parser = argparse.ArgumentParser(
        prog='weed',
        description=f'{node.weed_banner()} — real mechanisms behind the #all-pdx brainstorm.')
    parser.add_argument('--version', action='version', version=node.weed_banner())
    sub = parser.add_subparsers(dest='command', required=False)

    sub.add_parser('shell', help='interactive shell with tab completion (also the default with no command)')

    for name, (_target, help_text) in COMMANDS.items():
        sub.add_parser(name, help=help_text)

    lightning = sub.add_parser('lightning', help='real bitcoind + LND regtest stack (see lightning/README.md)')
    lightning_sub = lightning.add_subparsers(dest='lightning_command', required=True)
    for name, (_target, help_text) in LIGHTNING_COMMANDS.items():
        lightning_sub.add_parser(name, help=help_text)

    p_whoami = sub.add_parser('whoami', help='print your persistent node pubkey (~/.weed_identity.key)')

    p_host = sub.add_parser('host', help='actually serve a real archived file to the real network')
    p_host.add_argument('archive_dir', help='directory containing .ott/ (e.g. real_archive)')
    p_host.add_argument('--file', help='which archived file, if more than one (default: most recent)')
    p_host.add_argument('--port', type=int, default=9201)
    p_host.add_argument('--price', type=int, default=0, help='sats to charge per download (default: free)')
    p_host.add_argument('--lightning-node', choices=ln_nodes,
                         help='settle --price through this demo LND identity\'s own real BOLT11 '
                              'invoice (see lightning_settle.py; needs the lightning/ stack up) '
                              '— omit to leave this host unable to answer INVOICE at all')
    p_host.add_argument('--relay', action='append', default=_default_relay_list(),
                         help='relay URL to announce on (repeatable; default: $WEED_RELAY if set)')
    p_host.add_argument('--advertise-host', default='127.0.0.1',
                         help='address to tell the relay to advertise (set this to your real '
                              'reachable IP if hosting off localhost — or use --tunnel if you '
                              'have no reachable address at all, e.g. behind NAT/CGNAT)')
    p_host.add_argument('--tunnel', metavar='[tls://]RELAY_HOST:PORT', action='append',
                         default=_default_tunnel_list(),
                         help='tunnel_relay.py address to register with instead of relying on a '
                              'reachable inbound port — see tunnel_relay.py. Downloaders connect '
                              'through the relay, not to you directly. Repeatable (or comma-'
                              'separated): the host registers with every relay named, and a '
                              'downloader tries them in this order, so one relay being down is '
                              'not the end of it. Prefix with tls:// if the relay terminates TLS '
                              'at the edge (e.g. a Fly service with handlers = ["tls"]) — the '
                              'relay process itself never needs to know. Default: $WEED_TUNNEL if set.')

    p_discover = sub.add_parser('discover', help='list real content announced on one or more relays')
    p_discover.add_argument('--relay', action='append', default=[_default_relay()],
                             help='relay URL to query (repeatable; default: $WEED_RELAY if set, '
                                  'else http://127.0.0.1:9101)')

    p_download = sub.add_parser('download', aliases=['get'],
                                 help='discover, possession-challenge, auction, optionally pay, '
                                      'and download from the winning host — chunk-verified')
    p_download.add_argument('content_hash', nargs='?', help='content hash to resolve via --relay')
    p_download.add_argument('--from', dest='from_addr', help='host:port to connect to directly, skipping '
                             'discovery/auction entirely (no possession challenge, no reputation, no payment)')
    p_download.add_argument('--relay', action='append', default=[_default_relay()],
                             help='relay URL to resolve content_hash against (repeatable; '
                                  'default: $WEED_RELAY if set, else http://127.0.0.1:9101)')
    p_download.add_argument('--out', help='output path (default: the advertised filename)')
    p_download.add_argument('--challenge-rounds', type=int, default=3,
                             help='chunks to sample-verify per candidate host before trusting it (default: 3)')
    p_download.add_argument('--timing-rounds', type=int, default=5,
                             help='nonce-salted, timed CHALLENGE rounds per candidate after the sample '
                                  'check, reported as the median ratio of CHALLENGE time to a plain PRICE '
                                  'round trip on the same socket -- a holder answers from disk, a relay '
                                  'has to fetch upstream first (default: 5; 0 disables)')
    p_download.add_argument('--max-timing-ratio', type=float, default=None,
                             help='reject a candidate whose median timing ratio exceeds this. Off by '
                                  'default: the ratio is always measured and printed, and breaks ties '
                                  'in the auction, but the honest-vs-relay crossover depends on how far '
                                  'apart they are -- measure it live before picking a number')
    p_download.add_argument('--lightning', action='store_true',
                             help='pay the winning host over a real Lightning HTLC if it has a price '
                                  '(needs the lightning/ stack up — see lightning/README.md)')
    p_download.add_argument('--lightning-node', choices=ln_nodes,
                             help='pay as this demo LND identity — required with --lightning '
                                  'against a real priced host')

    p_like = sub.add_parser('like', help='sign and post a real like event')
    p_like.add_argument('content_hash')
    p_like.add_argument('--relay', action='append', default=[_default_relay()],
                         help='relay URL to post to (repeatable — the event goes to every one; '
                              'default: $WEED_RELAY if set, else http://127.0.0.1:9101)')

    p_subscribe = sub.add_parser('subscribe', help='sign and post a real subscribe event')
    p_subscribe.add_argument('target_pubkey')
    p_subscribe.add_argument('--relay', action='append', default=[_default_relay()],
                              help='relay URL to post to (repeatable — the event goes to every one; '
                                   'default: $WEED_RELAY if set, else http://127.0.0.1:9101)')

    p_sync = sub.add_parser('sync-relays', help='mirror events between relays so none lives on just one')
    p_sync.add_argument('--relay', action='append', default=_default_relay_list(),
                         help='relay URL (repeat once per relay; needs at least two)')
    p_sync.add_argument('--all', action='store_true',
                         help="mirror everyone's events, not just the ones you signed (the default "
                              "scope — see node.sync_relays for why)")

    p_web = sub.add_parser('web', help='local web UI — discover/host/download/like/subscribe '
                                        'from a browser instead of the CLI')
    p_web.add_argument('--port', type=int, default=8080)
    p_web.add_argument('--bind', default='127.0.0.1',
                        help='bind address (default 127.0.0.1 — local only; widen it with '
                             '--auth-token unless you trust everyone on that network)')
    p_web.add_argument('--auth-token', nargs='?', const='generate', metavar='TOKEN',
                        default=os.environ.get('WEED_UI_TOKEN') or None,
                        help='require a token for every API call: given a value, that token; '
                             'bare, a generated one (printed at startup, encoded in the QR). '
                             'Default: $WEED_UI_TOKEN if set, else no auth.')
    p_web.add_argument('--stream-token', nargs='?', const='generate', metavar='TOKEN',
                        default=os.environ.get('WEED_STREAM_TOKEN') or None,
                        help='guest-tier token (needs --auth-token): the party view only -- live '
                             'stream, now playing, vote on what is next, your links. Bare for a '
                             'generated one. Default: $WEED_STREAM_TOKEN if set.')
    p_web.add_argument('--stream-plain-port', type=int, metavar='PORT',
                        default=int(os.environ.get('WEED_STREAM_PLAIN_PORT') or 0) or None,
                        help='also serve just the stream endpoints over plain HTTP on this port, '
                             'for players that cannot do self-signed TLS (Roku IP-camera viewers, '
                             'smart TVs). Default: $WEED_STREAM_PLAIN_PORT if set.')
    p_web.add_argument('--advertise-host',
                        help='IP/hostname for the phone QR and lan-url instead of '
                             'auto-detecting it — use this if the startup QR was missing or '
                             'pointed at the wrong address')
    p_web.add_argument('--tls', action='store_true',
                        help='enable HTTPS; auto-generates a self-signed cert if --cert/--key omitted')
    p_web.add_argument('--cert', metavar='CERTFILE', help='PEM certificate file (used with --tls)')
    p_web.add_argument('--key', metavar='KEYFILE', help='PEM private key file (used with --tls)')

    p_serve = sub.add_parser('serve', help='alias for "web" with positional args, '
                                            'e.g. `serve 0.0.0.0 8080`')
    p_serve.add_argument('bind', nargs='?', default='127.0.0.1',
                          help='bind address (default 127.0.0.1; pass 0.0.0.0 to reach it '
                               'from your phone — no auth is built, only widen this on a '
                               'network you trust)')
    p_serve.add_argument('port', nargs='?', type=int, default=8080)
    p_serve.add_argument('--advertise-host',
                          help='IP/hostname for the phone QR and lan-url instead of '
                               'auto-detecting it — use this if the startup QR was missing or '
                               'pointed at the wrong address')

    return parser


def cmd_whoami(args):
    import node
    identity = node.load_or_create_identity()
    print(identity.pubkey_hex())


def cmd_host(args):
    import threading
    import node
    identity = node.load_or_create_identity()
    entries = node.load_manifest_entries(args.archive_dir, args.file)
    # fail fast, before announcing anything — a manifest entry with no
    # matching chunk data would otherwise get announced to the relay and
    # only fail later, in the background server thread
    all_leaves = {e['sha256']: node.load_leaves(args.archive_dir, e['sha256']) for e in entries}
    # Bind the real listening socket now, before announcing anything --
    # same reasoning as web_ui.py's _run_host_job and shell.py's do_host:
    # a port already in use only used to surface once run_host_server got
    # around to its own (later) bind, by which point every relay below
    # had already been told this host is reachable at host_addr. Binding
    # first and reusing the same socket in run_host_server (see sock=
    # below) means a taken port fails loudly here instead, before a
    # single relay ever hears about it.
    try:
        bound_sock = node.bind_host_port(args.port)
    except OSError as e:
        sys.exit(f'cannot bind port {args.port}: {e} — not announcing, nothing started')
    # one archive_dir, one merkle root, one commit -- computed once outside
    # the per-relay/per-entry loops below, not per file
    ott_status = node.ott_commit_status(args.archive_dir)
    for relay_url in args.relay:
        host_addr = f'{args.advertise_host}:{args.port}'
        for entry in entries:
            result = node.publish(identity, relay_url, entry['sha256'], entry['name'], host_addr,
                                   tunnel=args.tunnel, ott_status=ott_status)
            print(f"announced {entry['name']} on {relay_url}: {result}")
    # REGISTER's token is the file's own content hash (see
    # run_host_tunnel/connect_via_tunnel), so a whole tree just means one
    # control connection per file per relay, each registered under its
    # own hash — no protocol change needed, CONNECT already looks a
    # downloader's requested hash up the same way. Several relays means
    # several registrations per file: whichever one a downloader reaches
    # first serves it (see open_connection's failover).
    archive_dir = os.path.expanduser(args.archive_dir)
    for relay_host, relay_port, use_tls in node._parse_tunnels(args.tunnel):
        for entry in entries:
            file_path = node.resolve_file_path(entry, archive_dir)
            threading.Thread(target=node.run_host_tunnel,
                              args=(relay_host, relay_port, entry['sha256'], entry,
                                    all_leaves[entry['sha256']], file_path, args.price),
                              kwargs={'use_tls': use_tls, 'ln_node': args.lightning_node},
                              daemon=True).start()
    node.run_host_server(args.archive_dir, args.file, args.port, price=args.price,
                          ln_node=args.lightning_node, sock=bound_sock)


def cmd_discover(args):
    import node
    results = node.group_discover_by_content(node.discover(args.relay))
    if not results:
        print("nothing found (relay(s) unreachable, or nothing published yet)")
        return
    for r in results:
        hosts_note = f'  (+{r["host_count"] - 1} more host(s))' if r['host_count'] > 1 else ''
        print(f"  {r['title']!r:40s}  hash={r['content_hash'][:16]}...  host={r['host']}  "
              f"by={r['signer_pubkey'][:12]}...{hosts_note}")


def cmd_download(args):
    import node
    if args.from_addr:
        # skips discovery entirely, so no possession challenge, reputation,
        # or auction happens — a deliberate escape hatch, not the normal path
        out_path = args.out or f'download_{args.content_hash or "file"}'
        node.download(args.from_addr, out_path)
        return
    if not args.content_hash:
        sys.exit("need a content_hash (to resolve via --relay) or --from host:port")
    if args.lightning and not args.lightning_node:
        sys.exit("--lightning needs --lightning-node <alice|bob> to say who's paying")
    node.download_with_auction(args.content_hash, args.relay, out_path=args.out,
                                k=args.challenge_rounds, use_lightning=args.lightning,
                                lightning_node=args.lightning_node,
                                timing_rounds=args.timing_rounds, max_timing_ratio=args.max_timing_ratio)


def _print_broadcast(result):
    for relay_url, r in result['results'].items():
        print(f"  {'✓' if r.get('ok') else '✗'} {relay_url}: {r}")
    if not result['ok']:
        sys.exit('no relay accepted the event')


def cmd_like(args):
    import node
    identity = node.load_or_create_identity()
    _print_broadcast(node.like(identity, args.relay, args.content_hash))


def cmd_subscribe(args):
    import node
    identity = node.load_or_create_identity()
    _print_broadcast(node.subscribe(identity, args.relay, args.target_pubkey))


def cmd_sync_relays(args):
    import node
    if len(args.relay) < 2:
        sys.exit('sync-relays mirrors *between* relays — name at least two with --relay')
    identity = node.load_or_create_identity()
    report = node.sync_relays(args.relay, identity=identity, all_signers=args.all)
    for relay_url, r in report['relays'].items():
        failed = f", {r['failed']} failed" if r['failed'] else ''
        print(f"  {relay_url}: had {r['had']}, added {r['added']}{failed}")
    for relay_url in report['unreachable']:
        print(f"  {relay_url}: unreachable, skipped")
    scope = '' if args.all else " (yours only — --all mirrors everyone's)"
    print(f"  {report['events']} event(s) mirrored across {len(report['relays'])} relay(s){scope}")


def cmd_web(args):
    import web_ui
    web_ui.run_web_ui(port=args.port, bind_host=args.bind, advertise_host=args.advertise_host,
                      tls=getattr(args, 'tls', False),
                      certfile=getattr(args, 'cert', None),
                      keyfile=getattr(args, 'key', None),
                      auth_token=getattr(args, 'auth_token', None),
                      stream_plain_port=getattr(args, 'stream_plain_port', None),
                      stream_token=getattr(args, 'stream_token', None))


NATIVE_COMMANDS = {
    'whoami': cmd_whoami, 'host': cmd_host, 'discover': cmd_discover,
    'download': cmd_download, 'get': cmd_download, 'like': cmd_like, 'subscribe': cmd_subscribe,
    'sync-relays': cmd_sync_relays, 'web': cmd_web, 'serve': cmd_web,
}


def main():
    args = build_parser().parse_args()
    if args.command is None or args.command == 'shell':
        import shell
        try:
            shell.WeedShell().cmdloop()
        except KeyboardInterrupt:
            print()
        return
    if args.command in NATIVE_COMMANDS:
        NATIVE_COMMANDS[args.command](args)
        return
    if args.command == 'lightning':
        target, _ = LIGHTNING_COMMANDS[args.lightning_command]
    else:
        target, _ = COMMANDS[args.command]
    run_make(target)


if __name__ == '__main__':
    main()
