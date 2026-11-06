const FORWARDED = new Set(['balance', 'records', 'alert', 'breaker', 'sync']);
const MAX_BUFFERED = 1 << 20; // 1 MiB — beyond this a client is too slow

/**
 * Server-Sent Events fan-out.
 * One subscription to the event bus, N HTTP connections. Slow consumers
 * whose socket buffer grows past MAX_BUFFERED are disconnected instead of
 * letting memory grow unbounded (back-pressure).
 */
export class SseHub {
  constructor({ bus, logger, heartbeatMs = 15_000 }) {
    this.clients = new Set();
    this.logger = logger;
    this.sent = 0;
    this.dropped = 0;
    bus.on('*', (evt) => { if (FORWARDED.has(evt.type)) this.broadcast(evt); });
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(`: ping ${Date.now()}\n\n`);
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  handle(req, res, hello) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  broadcast(evt) {
    const frame = `id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`;
    for (const res of this.clients) {
      if (res.writableLength > MAX_BUFFERED) {
        this.dropped++;
        this.clients.delete(res);
        res.end();
        continue;
      }
      res.write(frame);
      this.sent++;
    }
  }

  closeAll() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  stats() {
    return { clients: this.clients.size, framesSent: this.sent, slowClientsDropped: this.dropped };
  }
}
