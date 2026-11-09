"""Loopback TCP forwarder: 127.0.0.1:<port> -> <server-ip>:<port> (bytes only, no inspection).

Template for onboard-bb-machine. Replace __SERVER_IP__ and __PORT__ (both occurrences of
__PORT__ must match) before installing it, for example:
  sed -e 's/__SERVER_IP__/100.116.88.55/g' -e 's/__PORT__/38886/g' bb-loopback-forward.py

Each accepted connection gets its own task. Each direction is pumped independently;
an EOF on one side is passed on as a half-close to the other side, and the connection
is closed once both directions have finished. Long-lived connections (WebSockets) are fine.
"""
import asyncio
import signal
import sys
import time

LISTEN_HOST, LISTEN_PORT = "127.0.0.1", __PORT__
TARGET_HOST, TARGET_PORT = "__SERVER_IP__", __PORT__
CHUNK = 65536


def log(msg):
    sys.stderr.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), msg))
    sys.stderr.flush()


async def pump(reader, writer, counter):
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            counter[0] += len(data)
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError) as exc:
        counter[1] = str(exc)
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
        except (ConnectionError, OSError):
            pass


async def close(writer):
    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionError, OSError):
        pass


async def handle(client_reader, client_writer):
    peer = client_writer.get_extra_info("peername")
    try:
        server_reader, server_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
    except OSError as exc:
        log("connect to %s:%d failed for %s: %s" % (TARGET_HOST, TARGET_PORT, peer, exc))
        await close(client_writer)
        return
    up, down = [0, None], [0, None]
    started = time.time()
    log("open %s" % (peer,))
    await asyncio.gather(
        pump(client_reader, server_writer, up),
        pump(server_reader, client_writer, down),
    )
    await close(server_writer)
    await close(client_writer)
    log("close %s up=%d down=%d seconds=%.1f errors=%s/%s" % (
        peer, up[0], down[0], time.time() - started, up[1], down[1]))


async def main():
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    log("listening on %s:%d -> %s:%d" % (LISTEN_HOST, LISTEN_PORT, TARGET_HOST, TARGET_PORT))
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
    async with server:
        await stop
    log("stopped")


if __name__ == "__main__":
    asyncio.run(main())
