// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
const DEFAULTS = Object.freeze({ maxSubscribers: 16, maxPerRun: 8, maxPendingBytes: 8 * 1024 * 1024, maxFrameBytes: 4 * 1024 * 1024, drainMs: 15000, heartbeatMs: 15000 });
export class SSEHub {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.connections = new Set(); this.frames = new WeakMap();
  }
  frame(event, value) {
    let entries = this.frames.get(value);
    if (!entries) { entries = {}; this.frames.set(value, entries); }
    if (entries[event]) return entries[event];
    const frame = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    // A valid historical round can exceed one live frame. Preserve the small
    // queue bound and let that owner fetch its full snapshot separately.
    return entries[event] = event === 'state' && Buffer.byteLength(frame) > this.options.maxFrameBytes
      ? `event: state-refresh\ndata: ${JSON.stringify({ runId: value.id })}\n\n` : frame;
  }
  open(req, res, runId) {
    if (this.connections.size >= this.options.maxSubscribers || [...this.connections].filter(item => item.runId === runId).length >= this.options.maxPerRun) {
      const error = new Error('Too many live viewers. Close another debate tab and retry.'); error.status = 429; throw error;
    }
    const connection = new SSEConnection(req, res, runId, this.options, () => this.connections.delete(connection));
    this.connections.add(connection);
    return connection;
  }
  close() { for (const connection of this.connections) connection.close(); }
}

export class SSEConnection {
  constructor(req, res, runId, options, removed) {
    this.req = req; this.res = res; this.runId = runId; this.options = options; this.removed = removed;
    this.pending = new Map(); this.pendingBytes = 0; this.blocked = false; this.closed = false; this.cleanups = [];
    this.onDrain = () => this.drain(); this.onClose = () => this.close();
    req.once('close', this.onClose); res.once('close', this.onClose); res.once('error', this.onClose); res.on('drain', this.onDrain);
    this.heartbeat = setInterval(() => this.send(': heartbeat\n\n', 'heartbeat'), options.heartbeatMs);
    this.heartbeat.unref?.();
  }
  addCleanup(callback) { if (!callback) return; if (this.closed) callback(); else this.cleanups.push(callback); }
  send(frame, key) {
    if (this.closed) return;
    if (this.res.destroyed || this.res.writableEnded) return this.close();
    const frameBytes = Buffer.byteLength(frame), bytes = frameBytes + 64; // Reserve HTTP chunk framing overhead.
    if (frameBytes > this.options.maxFrameBytes) return this.close();
    if (this.blocked) {
      // A state snapshot already contains all drafts as of its revision.
      if (key === 'state') { this.pending.clear(); this.pendingBytes = 0; }
      this.pendingBytes -= this.pending.get(key)?.bytes || 0;
      this.pending.set(key, { frame, bytes }); this.pendingBytes += bytes;
      if (this.pending.size > 16 || this.pendingBytes + (this.res.writableLength || 0) > this.options.maxPendingBytes) this.close();
      return;
    }
    this.write(frame, bytes);
  }
  write(frame, bytes) {
    if ((this.res.writableLength || 0) + this.pendingBytes + bytes > this.options.maxPendingBytes) return this.close();
    try {
      if (!this.res.write(frame)) {
        this.blocked = true;
        this.deadline = setTimeout(() => this.close(), this.options.drainMs); this.deadline.unref?.();
      }
      if ((this.res.writableLength || 0) + this.pendingBytes > this.options.maxPendingBytes) this.close();
    } catch { this.close(); }
  }
  drain() {
    if (this.closed) return;
    clearTimeout(this.deadline); this.deadline = null; this.blocked = false;
    while (this.pending.size && !this.blocked && !this.closed) {
      const [key, value] = this.pending.entries().next().value;
      this.pending.delete(key); this.pendingBytes -= value.bytes;
      this.write(value.frame, value.bytes);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.deadline); clearInterval(this.heartbeat);
    this.pending.clear(); this.pendingBytes = 0;
    this.req.removeListener('close', this.onClose); this.res.removeListener('close', this.onClose); this.res.removeListener('error', this.onClose); this.res.removeListener('drain', this.onDrain);
    for (const callback of this.cleanups.splice(0)) callback();
    this.removed();
    this.res.destroy();
  }
}
