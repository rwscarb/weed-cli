#!/usr/bin/env python3
"""
Orbit stream diagnostics.
Usage: python test_orbit_stream.py [--host 192.168.1.137] [--port 8080] [--seconds 10]

Tests:
  1. HTTP/1.1 connection stays open (not closed after first chunk)
  2. Chunks arrive continuously (not just one)
  3. Chunk arrival rate (should be ~10fps * 1316 bytes = ~13160 bytes/s min)
  4. MPEG-TS sync bytes present (0x47 every 188 bytes)
  5. Latency between chunks (should be <200ms between each)
"""
import argparse
import socket
import ssl
import time
import sys

def run(host, port, seconds, use_tls):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    print(f'Connecting to {host}:{port} (TLS={use_tls})...')
    raw = socket.create_connection((host, port), timeout=5)
    if use_tls:
        sock = ctx.wrap_socket(raw, server_hostname=host)
    else:
        sock = raw

    req = (
        f'GET /api/orbit-view HTTP/1.1\r\n'
        f'Host: {host}:{port}\r\n'
        f'Connection: keep-alive\r\n'
        f'\r\n'
    ).encode()
    sock.sendall(req)

    # Read response headers
    buf = b''
    while b'\r\n\r\n' not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            print('FAIL: connection closed before headers complete')
            return
        buf += chunk

    header_end = buf.index(b'\r\n\r\n') + 4
    headers = buf[:header_end].decode(errors='replace')
    body_start = buf[header_end:]

    print('\n--- Response headers ---')
    for line in headers.splitlines():
        print(f'  {line}')

    # Check HTTP version
    status_line = headers.splitlines()[0]
    if 'HTTP/1.1' not in status_line:
        print(f'\nWARN: server responded with {status_line.split()[0]}, not HTTP/1.1 — connection will close after first chunk')
    else:
        print(f'\nOK: HTTP/1.1 response')

    if '200' not in status_line:
        print(f'FAIL: non-200 status: {status_line}')
        return

    # Read body chunks and measure
    print(f'\n--- Streaming for {seconds}s ---')
    sock.settimeout(3.0)
    data = body_start
    chunk_times = []
    chunk_sizes = []
    ts_errors = 0
    total_bytes = 0
    deadline = time.time() + seconds
    last_chunk_time = time.time()

    while time.time() < deadline:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            now = time.time()
            gap = now - last_chunk_time
            print(f'  WARN: no data for {gap:.1f}s (timeout)')
            if gap > 5:
                print('  FAIL: stream stalled for >5s')
                break
            continue
        if not chunk:
            print('  FAIL: connection closed by server')
            break
        now = time.time()
        gap = now - last_chunk_time
        chunk_times.append(gap)
        chunk_sizes.append(len(chunk))
        total_bytes += len(chunk)
        last_chunk_time = now
        data += chunk

        # Check MPEG-TS sync bytes in this chunk
        for i in range(0, len(chunk) - 188, 188):
            if chunk[i] != 0x47:
                ts_errors += 1

        elapsed = time.time() - (deadline - seconds)
        print(f'  t={elapsed:5.1f}s  chunk={len(chunk):6d}b  gap={gap*1000:5.0f}ms  total={total_bytes//1024}KB', end='\r')

    print()
    print('\n--- Results ---')
    print(f'  Total bytes received : {total_bytes:,}  ({total_bytes//1024} KB)')
    print(f'  Chunks received      : {len(chunk_times)}')
    print(f'  Avg chunk size       : {int(sum(chunk_sizes)/max(len(chunk_sizes),1)):,} bytes')
    print(f'  Avg bitrate          : {total_bytes*8//seconds//1000} kbps')
    if chunk_times:
        gaps_ms = [g*1000 for g in chunk_times[1:]]  # skip first (includes connect)
        if gaps_ms:
            print(f'  Avg gap between chunks: {sum(gaps_ms)/len(gaps_ms):.0f}ms')
            print(f'  Max gap between chunks: {max(gaps_ms):.0f}ms')
            print(f'  Gaps >200ms           : {sum(1 for g in gaps_ms if g > 200)}')
            print(f'  Gaps >500ms           : {sum(1 for g in gaps_ms if g > 500)}')
    print(f'  MPEG-TS sync errors  : {ts_errors}')
    print(f'  HTTP/1.1             : {"OK" if "HTTP/1.1" in status_line else "FAIL — HTTP/1.0 closes after first chunk"}')

    if total_bytes < 1000:
        print('\nDIAGNOSIS: barely any data — stream not running or fanout not delivering')
    elif len(chunk_times) < 3:
        print('\nDIAGNOSIS: only 1-2 chunks — HTTP connection closing after first write (HTTP/1.0 or Content-Length issue)')
    elif gaps_ms and max(gaps_ms) > 2000:
        print('\nDIAGNOSIS: large gaps — ffmpeg encode stalling or queue not being fed')
    elif ts_errors > 10:
        print('\nDIAGNOSIS: MPEG-TS sync errors — corrupt stream or misaligned reads')
    else:
        print('\nDIAGNOSIS: stream looks healthy from network perspective')

    sock.close()

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='192.168.1.137')
    p.add_argument('--port', type=int, default=8080)
    p.add_argument('--seconds', type=int, default=10)
    p.add_argument('--no-tls', action='store_true')
    args = p.parse_args()
    run(args.host, args.port, args.seconds, not args.no_tls)
