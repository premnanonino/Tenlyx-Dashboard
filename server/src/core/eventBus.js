import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub. Producers (sync jobs, alert engine) never talk to
 * consumers (SSE hub, cache) directly — they publish typed events here.
 * Swapping this for Redis pub/sub or NATS is the horizontal-scale path.
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.seq = 0;
    this.counts = new Map();
  }

  publish(type, payload) {
    const event = { id: ++this.seq, type, ts: Date.now(), payload };
    this.counts.set(type, (this.counts.get(type) || 0) + 1);
    this.emit(type, event);
    this.emit('*', event);
    return event;
  }

  stats() {
    return { published: this.seq, byType: Object.fromEntries(this.counts) };
  }
}
