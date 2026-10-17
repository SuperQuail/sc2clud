// 极简 WebSocket 客户端（只够说 CDP 的 JSON 文本帧）。
// 为什么自己写：本仓库 web/node_modules 里没有 ws，而我不想为盲测装依赖。
// shortcut: 只处理 text 帧、不做分片重组；CDP 的消息都小于 64KB 帧上限之外时才有风险，实测未见。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class MiniWS extends EventEmitter {
  constructor(url) {
    super();
    const u = new URL(url);
    this.buf = Buffer.alloc(0);
    this.sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock.write(
        'GET ' + u.pathname + (u.search || '') + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    this.ready = false;
    this.sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (!this.ready) {
        const i = this.buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = this.buf.subarray(0, i).toString();
        if (!/ 101 /.test(head.split('\r\n')[0])) { this.emit('error', new Error('handshake: ' + head.split('\r\n')[0])); return; }
        this.buf = this.buf.subarray(i + 4);
        this.ready = true;
        this.emit('open');
      }
      this.drain();
    });
    this.sock.on('error', (e) => this.emit('error', e));
    this.sock.on('close', () => this.emit('close'));
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) { const m = this.buf.subarray(off - 4, off); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
      this.buf = this.buf.subarray(off + len);
      if (op === 1) this.emit('message', payload.toString('utf8'));
      else if (op === 8) { this.sock.end(); return; }
    }
  }
  send(str) {
    const data = Buffer.from(str, 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(data.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(data.length), 2); }
    const masked = Buffer.from(data.map((v, i) => v ^ mask[i % 4]));
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  close() { try { this.sock.destroy(); } catch {} }
}

export function cdp(wsUrl) {
  const ws = new MiniWS(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.on('message', (txt) => {
    let m; try { m = JSON.parse(txt); } catch { return; }
    if (m.id !== undefined) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (p) m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else for (const l of listeners) l(m);
  });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    ready, ws,
    on: (fn) => listeners.push(fn),
    off: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    send: async (method, params = {}) => {
      await ready;
      const myId = ++id;
      const p = new Promise((resolve, reject) => pending.set(myId, { resolve, reject }));
      ws.send(JSON.stringify({ id: myId, method, params }));
      return p;
    },
    close: () => ws.close(),
  };
}
