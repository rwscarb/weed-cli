#!/usr/bin/env python3
"""
Orbit stream diagnostics -- run from any machine on the LAN while a
browser is streaming, to see the MJPEG relay the way a viewer does.

Usage: python orbit_stream_diag.py [--host 192.168.1.137] [--port 8080] [--seconds 10] [--no-tls]

Checks:
  1. /api/orbit-stream says a streamer is connected, and at what resolution
  2. /api/orbit-view answers HTTP/1.1 200 multipart/x-mixed-replace
  3. Every part is one whole JPEG: starts FF D8, ends FF D9, length matches
  4. Frame rate and frame-to-frame gaps over the run
  5. What arrived here vs. what the server says it received from the
     browser (its `rx` counters). A difference is the server->viewer hop;
     the browser's own console line ("[orbit] sent ...") covers the hop
     before it.

(This used to look for MPEG-TS sync bytes from an ffmpeg pipeline that no
longer exists -- the stream has been relayed JPEGs for a while now.)
"""
import argparse
import http.client
import json
import socket
import ssl
import sys
import time


def _tls_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def fetch_status(host, port, use_tls):
    cls = http.client.HTTPSConnection if use_tls else http.client.HTTPConnection
    kw = {'context': _tls_ctx()} if use_tls else {}
    conn = cls(host, port, timeout=5, **kw)
    try:
        conn.request('GET', '/api/orbit-stream')
        resp = conn.getresponse()
        return json.loads(resp.read().decode())
    finally:
        conn.close()


def read_part(sock, leftover):
    """Returns (jpeg_bytes, header_text, leftover) for the next multipart
    part, or (None, reason, leftover) if the stream ended."""
    buf = leftover
    while b'\r\n\r\n' not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            return None, 'connection closed by server', buf
        buf += chunk
    head, body = buf.split(b'\r\n\r\n', 1)
    if not head.startswith(b'--orbit'):
        return None, f'part does not start with boundary: {head[:40]!r}', body
    try:
        length = int(head.split(b'Content-Length: ')[1].split(b'\r\n')[0])
    except (IndexError, ValueError):
        return None, f'no Content-Length in part header: {head!r}', body
    while len(body) < length + 2:
        chunk = sock.recv(65536)
        if not chunk:
            return None, 'connection closed mid-frame', body
        body += chunk
    return body[:length], head.decode(errors='replace'), body[length + 2:]


def run(host, port, seconds, use_tls):
    print(f'--- /api/orbit-stream (before) ---')
    try:
        before = fetch_status(host, port, use_tls)
    except Exception as e:
        print(f'FAIL: could not fetch status: {e}')
        return 1
    print(f'  active={before.get("active")}  res={before.get("res")}  viewers={before.get("viewers")}  rx={before.get("rx")}')
    if not before.get('active'):
        print('  WARN: no browser is streaming right now -- /api/orbit-view will just sit there')

    print(f'\nConnecting to {host}:{port} (TLS={use_tls})...')
    raw = socket.create_connection((host, port), timeout=5)
    sock = _tls_ctx().wrap_socket(raw, server_hostname=host) if use_tls else raw
    sock.sendall(f'GET /api/orbit-view HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'.encode())

    buf = b''
    while b'\r\n\r\n' not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            print('FAIL: connection closed before response headers')
            return 1
        buf += chunk
    head, leftover = buf.split(b'\r\n\r\n', 1)
    headers = head.decode(errors='replace')
    print('\n--- Response headers ---')
    for line in headers.splitlines():
        print(f'  {line}')
    status_line = headers.splitlines()[0]
    if '200' not in status_line:
        print(f'FAIL: non-200 status: {status_line}')
        return 1
    if 'multipart/x-mixed-replace' not in headers:
        print('FAIL: not a multipart/x-mixed-replace response')
        return 1
    print('OK: HTTP/1.1 200 multipart/x-mixed-replace' if 'HTTP/1.1' in status_line
          else f'WARN: {status_line.split()[0]} response, expected HTTP/1.1')

    print(f'\n--- Reading frames for {seconds}s ---')
    sock.settimeout(3.0)
    t_start = time.time()
    deadline = t_start + seconds
    arrivals, sizes = [], []
    bad_jpeg = 0
    last = t_start
    while time.time() < deadline:
        try:
            jpeg, info, leftover = read_part(sock, leftover)
        except socket.timeout:
            gap = time.time() - last
            print(f'  WARN: no frame for {gap:.1f}s')
            if gap > 6:
                print('  FAIL: stream stalled')
                break
            continue
        if jpeg is None:
            print(f'  FAIL: {info}')
            break
        now = time.time()
        arrivals.append(now)
        sizes.append(len(jpeg))
        if not (jpeg[:2] == b'\xff\xd8' and jpeg[-2:] == b'\xff\xd9'):
            bad_jpeg += 1
        gap_ms = (now - last) * 1000
        last = now
        print(f'  t={now - t_start:5.1f}s  frame={len(jpeg):7d}b  gap={gap_ms:5.0f}ms  n={len(arrivals)}', end='\r')
    print()
    sock.close()

    elapsed = max(time.time() - t_start, 1e-6)
    total = sum(sizes)
    print('\n--- Results ---')
    print(f'  Frames received      : {len(arrivals)}')
    print(f'  Frame rate           : {len(arrivals) / elapsed:.1f} fps')
    print(f'  Avg frame size       : {int(total / max(len(sizes), 1)):,} bytes')
    print(f'  Throughput           : {total / elapsed / 1024:.0f} KB/s')
    print(f'  Malformed JPEGs      : {bad_jpeg}')
    gaps = [(b - a) * 1000 for a, b in zip(arrivals, arrivals[1:])]
    if gaps:
        gaps_sorted = sorted(gaps)
        p95 = gaps_sorted[int(len(gaps_sorted) * 0.95) - 1] if len(gaps_sorted) > 1 else gaps_sorted[0]
        print(f'  Gap avg / p95 / max  : {sum(gaps) / len(gaps):.0f} / {p95:.0f} / {max(gaps):.0f} ms')
        print(f'  Gaps > 100ms         : {sum(1 for g in gaps if g > 100)}')
        print(f'  Gaps > 500ms         : {sum(1 for g in gaps if g > 500)}')

    try:
        after = fetch_status(host, port, use_tls)
        rx = after.get('rx') or {}
        print(f'\n--- Server-side rx (last 5s window) ---')
        print(f'  fps={rx.get("fps")}  KB/s={rx.get("kbps")}  dropped={rx.get("dropped")}  res={after.get("res")}  viewers={after.get("viewers")}')
        srv_fps = rx.get('fps') or 0
        here_fps = len(arrivals) / elapsed
        if srv_fps and here_fps < srv_fps * 0.8:
            print(f'  NOTE: server received {srv_fps} fps but only {here_fps:.1f} fps arrived here -> server->viewer hop is losing frames')
    except Exception as e:
        print(f'\n(could not re-fetch status: {e})')

    print()
    if not arrivals:
        print('DIAGNOSIS: no frames at all -- nothing streaming, or the fanout is not reaching this viewer')
    elif bad_jpeg:
        print('DIAGNOSIS: malformed JPEG parts -- framing bug between the WebSocket and the multipart writer')
    elif gaps and max(gaps) > 1000:
        print('DIAGNOSIS: multi-second gaps -- the browser stopped sending (tab hidden? heavy viz mode?); compare its console line')
    elif len(arrivals) / elapsed < 15:
        print('DIAGNOSIS: low but steady rate -- check the browser console line for encode/capture cost or backlog skips')
    else:
        print('DIAGNOSIS: stream looks healthy from the viewer side; if VLC is still choppy, it is VLC (try --network-caching=200, never --mjpeg-fps)')
    return 0


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--host', default='192.168.1.137')
    p.add_argument('--port', type=int, default=8080)
    p.add_argument('--seconds', type=int, default=10)
    p.add_argument('--no-tls', action='store_true')
    args = p.parse_args()
    sys.exit(run(args.host, args.port, args.seconds, not args.no_tls))
