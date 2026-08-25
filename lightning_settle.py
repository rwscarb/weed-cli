#!/usr/bin/env python3
"""
Real Lightning HTLC settlement, replacing poc_challenge_auction.py's mock
"settlement: mock Lightning HTLC held until delivery confirms" print.

Talks to real LND nodes (lnd-alice, lnd-bob — see lightning/docker-compose.yml)
over a real channel on regtest via `docker exec ... lncli`. Not simulated:
real BOLT11 invoices, real onion-routed HTLCs, real preimage reveal on
settlement — same protocol code LND runs on mainnet, just against a private
regtest chain instead of waiting on public testnet sync/faucets (same
reasoning as using a real remote box over SSH for the WAN latency test
rather than a fabricated one).

Requires the compose stack in lightning/ to be up with a funded, active
channel between alice and bob (see lightning/README.md for the one-time
setup: fund alice on-chain, open channel, confirm).

create_invoice/pay_invoice are the pieces `node.py`'s real download path
uses (INVOICE wire verb + download()'s --lightning step): whichever demo
node a host names with --lightning-node creates its own invoice, whichever
node the downloader names as --lightning-node pays that exact invoice —
paying whoever actually won the auction, not a fixed direction. settle()
stays as a plain alice-pays-bob convenience wrapper for
poc_challenge_auction.py's standalone demo, which has no real host/
downloader identities to plug in.
"""
import hashlib
import json
import subprocess

NODES = {
    'alice': 'lightning-lnd-alice-1',
    'bob': 'lightning-lnd-bob-1',
}
LNDDIR = '/home/lnd/.lnd'


class SettlementError(RuntimeError):
    pass


def _lncli(container, *args):
    cmd = ['docker', 'exec', container, 'lncli', '--network=regtest', f'--lnddir={LNDDIR}', *args]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise SettlementError(f'lncli {args[0]} failed: {result.stderr.strip()}')
    return json.loads(result.stdout)


def _container(node):
    if node not in NODES:
        raise SettlementError(f'unknown lightning node {node!r} — known nodes: {", ".join(NODES)}')
    return NODES[node]


def channel_active(node='alice'):
    try:
        chans = _lncli(_container(node), 'listchannels')
    except (SettlementError, FileNotFoundError):
        return False
    return any(c.get('active') for c in chans.get('channels', []))


def create_invoice(node, amount_sat, memo):
    """A real BOLT11 invoice from `node`'s own LND — the piece a host needs
    to actually get paid as itself, instead of settlement happening through
    a side-channel-known fixed pair regardless of who really hosted."""
    amount_sat = max(1, int(round(amount_sat)))
    invoice = _lncli(_container(node), 'addinvoice', f'--amt={amount_sat}', f'--memo={memo}')
    return {
        'payment_request': invoice['payment_request'],
        'payment_hash': invoice['r_hash'],
        'amount_sat': amount_sat,
    }


def pay_invoice(payer_node, payment_request, expected_hash):
    """Pay a specific BOLT11 invoice (as returned by create_invoice, possibly
    on a different node) from `payer_node`'s own LND. Independently
    re-verifies sha256(preimage) == payment_hash locally rather than
    trusting LND's own claim of success — same "verify, don't just trust
    the tool's own report" standard the rest of this project uses
    throughout."""
    payment = _lncli(_container(payer_node), 'payinvoice', '--force', '--json', payment_request)
    if payment.get('status') != 'SUCCEEDED':
        raise SettlementError(f'payment did not succeed: {payment.get("status")}')

    preimage = payment['payment_preimage']
    recomputed_hash = hashlib.sha256(bytes.fromhex(preimage)).hexdigest()
    if recomputed_hash != expected_hash:
        raise SettlementError(
            f'preimage does not match invoice payment_hash — '
            f'got {recomputed_hash}, expected {expected_hash}')

    return {
        'payment_hash': expected_hash,
        'preimage': preimage,
        'fee_sat': int(payment.get('fee_sat', 0)),
        'verified_locally': True,
    }


def settle(amount_sat, memo, payee='bob', payer='alice'):
    """Real HTLC settlement for one auction round's winning bid, fixed
    payee/payer identities — used by poc_challenge_auction.py's standalone
    demo, which never has a real distinct host/downloader to plug into
    create_invoice/pay_invoice itself. Real node.py downloads use those two
    functions directly instead, against whichever nodes --lightning-node
    actually names on each side."""
    amount_sat = max(1, int(round(amount_sat)))
    invoice = create_invoice(payee, amount_sat, memo)
    payment = pay_invoice(payer, invoice['payment_request'], invoice['payment_hash'])
    return {**payment, 'amount_sat': amount_sat}


if __name__ == '__main__':
    # smoke test — run directly to confirm the channel is up before wiring
    # it into the auction
    if not channel_active():
        print('no active channel found — bring up lightning/docker-compose.yml first')
        raise SystemExit(1)
    result = settle(1234, 'lightning_settle.py smoke test')
    print(json.dumps(result, indent=2))
    print('\npreimage independently re-hashed and matched the invoice payment_hash — real HTLC, verified.')
