import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const Messages = require('slsk-client/lib/messages.js');
const Message = require('slsk-client/lib/message.js');
const MessageFactory = require('slsk-client/lib/message-factory.js');
const DefaultPeer = require('slsk-client/lib/peer/default-peer.js');
const DistributedPeer = require('slsk-client/lib/peer/distributed-peer.js');
const Listen = require('slsk-client/lib/listen.js');
const downloadPeerFile = require('slsk-client/lib/peer/download-peer-file.js');
const stack = require('slsk-client/lib/stack.js');

const unzip = promisify(zlib.unzip);

const APP_VERSION = '2.0.0';
const SERVER_HOST = process.env.SLSK_SERVER_HOST || 'server.slsknet.org';
const SERVER_PORT = Number(process.env.SLSK_SERVER_PORT || 2242);
const INCOMING_PORT = Number(process.env.SLSK_INCOMING_PORT || 2234);
const HTTP_PORT = Number(process.env.PORT || 3000);
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const HEALTH_PATH = process.env.HEALTH_PATH || '/health';
const DOCS_PATH = process.env.DOCS_PATH || '/docs';
const FILES_PATH = process.env.FILES_PATH || '/files';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const SLSK_USER = process.env.SLSK_USER || '';
const SLSK_PASS = process.env.SLSK_PASS || '';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');
const AUTO_JOIN_ROOMS_FILE = process.env.AUTO_JOIN_ROOMS_FILE || path.join(process.cwd(), 'data', 'auto-join-rooms.json');
const RUN_MODE = process.env.MCP_TRANSPORT || 'http';
const MAX_LOG_ITEMS = Number(process.env.MAX_LOG_ITEMS || 200);
const MAX_SHARE_RESULTS = Number(process.env.MAX_SHARE_RESULTS || 3000);

function ensureEnv() {
  const missing = [];
  if (!SLSK_USER) missing.push('SLSK_USER');
  if (!SLSK_PASS) missing.push('SLSK_PASS');
  if ((RUN_MODE === 'http' || RUN_MODE === 'both') && !MCP_AUTH_TOKEN) missing.push('MCP_AUTH_TOKEN');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function trimLog(list, max = MAX_LOG_ITEMS) {
  while (list.length > max) list.shift();
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function appendLog(map, key, entry, max = MAX_LOG_ITEMS) {
  if (!map.has(key)) map.set(key, []);
  const list = map.get(key);
  list.push(entry);
  trimLog(list, max);
}

function boolByte(value) {
  return value ? 1 : 0;
}

function normalizeSlskPath(value) {
  return String(value || '').replaceAll('/', '\\');
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  return Number((n / 1024 / 1024).toFixed(2));
}

function safeRelativePath(value) {
  const normalized = path.posix.normalize(String(value || '').replaceAll('\\', '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..')) {
    throw new Error('Invalid relative path');
  }
  return normalized;
}

function resolveDownloadPath(relativePath) {
  const safe = safeRelativePath(relativePath);
  const full = path.resolve(DOWNLOAD_DIR, safe);
  const base = path.resolve(DOWNLOAD_DIR);
  if (!full.startsWith(base + path.sep) && full !== base) throw new Error('Path escapes download directory');
  return { safe, full };
}

function nowIso() {
  return new Date().toISOString();
}

function makePeerTokenHex(value = 0) {
  const token = Number(value) >>> 0;
  return token.toString(16).padStart(8, '0');
}

async function buildLocalShareDirectories(rootDir) {
  await fs.mkdir(rootDir, { recursive: true });
  const directories = new Map();

  const ensureDirectory = (directory) => {
    if (!directories.has(directory)) directories.set(directory, { directory, files: [], private: false });
    return directories.get(directory);
  };

  const walk = async (dir, prefix = '') => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        ensureDirectory(normalizeSlskPath(rel));
        await walk(full, rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        const baseDir = prefix ? normalizeSlskPath(prefix) : '';
        ensureDirectory(baseDir).files.push({
          directory: baseDir,
          name: entry.name,
          extension: path.extname(entry.name).slice(1).toLowerCase(),
          file: normalizeSlskPath(rel),
          size: String(stat.size),
          sizeMb: formatSize(stat.size)
        });
      }
    }
  };

  await walk(rootDir);

  return Array.from(directories.values())
    .map((directory) => ({
      ...directory,
      files: directory.files.sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.directory.localeCompare(b.directory));
}

function filterFolderDirectories(directories, folder) {
  const normalizedFolder = normalizeSlskPath(folder);
  return directories.filter((entry) => entry.directory === normalizedFolder || entry.directory.startsWith(`${normalizedFolder}\\`));
}

function readUInt64LE(message) {
  const low = BigInt(message.read32());
  const high = BigInt(message.read32());
  return (high << 32n) + low;
}

function writeUInt64LE(bufMessage, value) {
  const big = BigInt(value);
  const b = Buffer.alloc(8);
  b.writeUInt32LE(Number(big & 0xffffffffn), 0);
  b.writeUInt32LE(Number((big >> 32n) & 0xffffffffn), 4);
  bufMessage.writeBuffer(b);
  return bufMessage;
}

function parseAttributes(message, count) {
  const attrs = {};
  for (let i = 0; i < count; i += 1) {
    const code = message.read32();
    const value = message.read32();
    attrs[code] = value;
  }
  return attrs;
}

function parseFileEntry(message, baseDir) {
  message.read8();
  const name = message.str();
  const size = readUInt64LE(message);
  const ext = message.str();
  const attrCount = message.read32();
  const attributes = parseAttributes(message, attrCount);
  const fullPath = baseDir ? `${baseDir}\\${name}` : name;
  return {
    directory: baseDir,
    name,
    extension: ext,
    file: fullPath,
    size: size.toString(),
    sizeMb: formatSize(Number(size)),
    bitrate: attributes[0],
    duration: attributes[1],
    vbr: attributes[2],
    sampleRate: attributes[4],
    bitDepth: attributes[5],
    attributes
  };
}

async function parseSharedFileList(buffer) {
  const raw = await unzip(buffer);
  const msg = new Message(raw);
  const directories = [];
  const dirCount = msg.read32();
  for (let i = 0; i < dirCount; i += 1) {
    const directory = msg.str();
    const fileCount = msg.read32();
    const files = [];
    for (let j = 0; j < fileCount; j += 1) files.push(parseFileEntry(msg, directory));
    directories.push({ directory, files, private: false });
  }
  msg.read32();
  const privateCount = msg.read32();
  for (let i = 0; i < privateCount; i += 1) {
    const directory = msg.str();
    const fileCount = msg.read32();
    const files = [];
    for (let j = 0; j < fileCount; j += 1) files.push(parseFileEntry(msg, directory));
    directories.push({ directory, files, private: true });
  }
  return directories;
}

async function parseFolderContents(buffer) {
  const raw = await unzip(buffer);
  const msg = new Message(raw);
  const token = msg.read32();
  const folder = msg.str();
  const count = msg.read32();
  const folders = [];
  for (let i = 0; i < count; i += 1) {
    const dir = msg.str();
    const fileCount = msg.read32();
    const files = [];
    for (let j = 0; j < fileCount; j += 1) files.push(parseFileEntry(msg, dir));
    folders.push({ directory: dir, files });
  }
  return { token, folder, folders };
}

class SoulseekSession {
  constructor() {
    this.serverSocket = null;
    this.listen = null;
    this.connected = false;
    this.loginPromise = null;
    this.serverMessages = null;
    this.rooms = new Map();
    this.roomMessages = new Map();
    this.privateMessages = new Map();
    this.downloads = new Map();
    this.watchedUsers = new Map();
    this.roomList = [];
    this.pendingPeerAddresses = new Map();
    this.pendingRoomLists = [];
    this.pendingUserStatus = new Map();
    this.pendingRoomJoins = new Map();
    this.pendingBrowseShares = new Map();
    this.pendingBrowseFolders = new Map();
    this.peers = {};
    this.autoJoinRooms = [];
  }

  async ensureConnected() {
    if (this.connected) return;
    if (!this.loginPromise) this.loginPromise = this.connect();
    await this.loginPromise;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: SERVER_HOST, port: SERVER_PORT });
      this.serverSocket = socket;
      this.serverMessages = new Messages();

      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      socket.on('error', fail);
      socket.on('close', () => {
        this.connected = false;
        this.loginPromise = null;
      });
      socket.on('data', (data) => this.serverMessages.write(data));
      this.serverMessages.on('message', (msg) => {
        try {
          this.handleServerMessage(msg, resolve, reject, () => {
            settled = true;
          });
        } catch (error) {
          fail(error);
        }
      });

      socket.on('connect', () => {
        const login = new Message();
        login.int32(1);
        login.str(SLSK_USER);
        login.str(SLSK_PASS);
        login.int32(175);
        login.str(md5(`${SLSK_USER}${SLSK_PASS}`));
        login.int32(1);
        socket.write(login.getBuff());
      });
    });
  }

  handleServerMessage(msg, resolve, reject, markSettled) {
    const size = msg.read32();
    if (size < 4) return;
    const code = msg.read32();

    switch (code) {
      case 1: {
        const success = msg.read8();
        if (success !== 1) {
          const reason = msg.str();
          markSettled();
          reject(new Error(`Soulseek login failed: ${reason}`));
          return;
        }
        this.connected = true;
        this.setupIncomingListener();
        this.sendSharedFoldersFiles();
        this.sendHaveNoParents();
        this.sendSetStatus(2);
        markSettled();
        resolve();
        break;
      }
      case 3: {
        const user = msg.str();
        const ip = [msg.read8(), msg.read8(), msg.read8(), msg.read8()];
        const host = `${ip[3]}.${ip[2]}.${ip[1]}.${ip[0]}`;
        const port = msg.read32();
        const pending = this.pendingPeerAddresses.get(user) || [];
        pending.forEach((entry) => entry.resolve({ user, host, port }));
        this.pendingPeerAddresses.delete(user);
        if (this.peers[user]) this.peers[user].setAddress(host, port);
        break;
      }
      case 5: {
        const username = msg.str();
        const exists = msg.read8() === 1;
        let payload = { username, exists };
        if (exists) {
          payload = {
            ...payload,
            status: msg.read32(),
            avgSpeed: msg.read32(),
            uploadNum: msg.read32(),
            unknown: msg.read32(),
            files: msg.read32(),
            dirs: msg.read32()
          };
          if (payload.status === 1 || payload.status === 2) payload.country = msg.str();
          this.watchedUsers.set(username, payload);
        }
        const pending = this.pendingUserStatus.get(username) || [];
        pending.forEach((entry) => entry.resolve(payload));
        this.pendingUserStatus.delete(username);
        break;
      }
      case 7: {
        const username = msg.str();
        const status = msg.read32();
        const privileged = msg.read8() === 1;
        const current = this.watchedUsers.get(username) || { username };
        this.watchedUsers.set(username, { ...current, username, status, privileged });
        break;
      }
      case 13: {
        const room = msg.str();
        const username = msg.str();
        const text = msg.str();
        appendLog(this.roomMessages, room, { room, username, message: text, at: nowIso() });
        break;
      }
      case 14: {
        const room = msg.str();
        const count = msg.read32();
        const users = [];
        for (let i = 0; i < count; i += 1) users.push(msg.str());

        const statusesCount = msg.read32();
        const statuses = [];
        for (let i = 0; i < statusesCount; i += 1) statuses.push(msg.read32());

        const statsCount = msg.read32();
        const stats = [];
        for (let i = 0; i < statsCount; i += 1) {
          stats.push({
            avgSpeed: msg.read32(),
            uploadNum: msg.read32(),
            unknown: msg.read32(),
            files: msg.read32(),
            dirs: msg.read32()
          });
        }

        const slotsCount = msg.read32();
        const slots = [];
        for (let i = 0; i < slotsCount; i += 1) slots.push(msg.read32());

        const countryCount = msg.read32();
        const countries = [];
        for (let i = 0; i < countryCount; i += 1) countries.push(msg.str());

        const roster = users.map((username, index) => ({
          username,
          status: statuses[index],
          slotsFull: slots[index] === 1,
          country: countries[index],
          ...(stats[index] || {})
        }));

        const roomState = { room, users: roster, joinedAt: nowIso() };
        this.rooms.set(room, roomState);
        const pending = this.pendingRoomJoins.get(room) || [];
        pending.forEach((entry) => entry.resolve(roomState));
        this.pendingRoomJoins.delete(room);
        break;
      }
      case 15: {
        const room = msg.str();
        this.rooms.delete(room);
        break;
      }
      case 16: {
        const room = msg.str();
        const username = msg.str();
        const user = {
          username,
          status: msg.read32(),
          avgSpeed: msg.read32(),
          uploadNum: msg.read32(),
          unknown: msg.read32(),
          files: msg.read32(),
          dirs: msg.read32(),
          slotsFull: msg.read32() === 1,
          country: msg.str()
        };
        const existing = this.rooms.get(room) || { room, users: [] };
        existing.users = existing.users.filter((item) => item.username !== username);
        existing.users.push(user);
        this.rooms.set(room, existing);
        break;
      }
      case 17: {
        const room = msg.str();
        const username = msg.str();
        const existing = this.rooms.get(room);
        if (existing) existing.users = existing.users.filter((item) => item.username !== username);
        break;
      }
      case 18: {
        const user = msg.str();
        const type = msg.str();
        const ip = [msg.read8(), msg.read8(), msg.read8(), msg.read8()];
        const host = `${ip[3]}.${ip[2]}.${ip[1]}.${ip[0]}`;
        const port = msg.read32();
        const token = msg.readRawHexStr(4);
        this.connectToPeer({ user, host, port, token, type });
        break;
      }
      case 22: {
        const id = msg.read32();
        const timestamp = msg.read32();
        const username = msg.str();
        const text = msg.str();
        const isNew = msg.read8() === 1;
        appendLog(this.privateMessages, username, { id, timestamp, username, message: text, isNew, direction: 'inbound' });
        this.sendMessageAck(id);
        break;
      }
      case 36: {
        const username = msg.str();
        const avgSpeed = msg.read32();
        const downloadNum = msg.read32();
        const something = msg.read32();
        const files = msg.read32();
        const folders = msg.read32();
        const current = this.watchedUsers.get(username) || { username };
        this.watchedUsers.set(username, { ...current, avgSpeed, downloadNum, something, files, folders });
        break;
      }
      case 64: {
        const number = msg.read32();
        const rooms = [];
        for (let i = 0; i < number; i += 1) rooms.push({ name: msg.str() });
        for (let i = 0; i < number; i += 1) rooms[i].users = msg.read32();
        this.roomList = rooms;
        const pending = this.pendingRoomLists.splice(0);
        pending.forEach((entry) => entry.resolve(rooms));
        break;
      }
      case 152: {
        const room = msg.str();
        const username = msg.str();
        const text = msg.str();
        appendLog(this.roomMessages, room, { room, username, message: text, at: nowIso(), global: true });
        break;
      }
      case 1001:
        break;
      default:
        break;
    }
  }

  setupIncomingListener() {
    if (this.listen) return;
    this.listen = new Listen(INCOMING_PORT);
    this.listen.on('new-peer', (evt) => {
      const peer = evt.peer;
      if (this.peers[peer.user]) return;
      this.peers[peer.user] = new DefaultPeer(evt.socket, peer);
      this.attachPeerLifecycle(peer.user, this.peers[peer.user]);
    });
    this.sendSetWaitPort(INCOMING_PORT);
  }

  attachPeerLifecycle(user, peer) {
    peer.on('disconnect', () => {
      delete this.peers[user];
    });
  }

  sendServerMessage(code, writer) {
    if (!this.serverSocket) throw new Error('Soulseek server socket not connected');
    const msg = new Message();
    msg.int32(code);
    if (writer) writer(msg);
    this.serverSocket.write(msg.getBuff());
  }

  sendSetWaitPort(port) {
    this.sendServerMessage(2, (msg) => msg.int32(port));
  }

  sendSetStatus(status) {
    this.sendServerMessage(28, (msg) => msg.int32(status));
  }

  sendSharedFoldersFiles() {
    this.sendServerMessage(35, (msg) => {
      msg.int32(1);
      msg.int32(1);
    });
  }

  sendHaveNoParents() {
    this.sendServerMessage(71, (msg) => msg.int32(1));
  }

  sendMessageAck(id) {
    this.sendServerMessage(23, (msg) => msg.int32(id));
  }

  async requestPeerAddress(username) {
    await this.ensureConnected();
    if (this.peers[username]?.peer?.host && this.peers[username]?.peer?.port) {
      return { user: username, host: this.peers[username].peer.host, port: this.peers[username].peer.port };
    }
    return new Promise((resolve) => {
      if (!this.pendingPeerAddresses.has(username)) this.pendingPeerAddresses.set(username, []);
      this.pendingPeerAddresses.get(username).push({ resolve });
      this.sendServerMessage(3, (msg) => msg.str(username));
    });
  }

  connectToPeer(peer) {
    switch (peer.type) {
      case 'F': {
        downloadPeerFile(peer.host, peer.port, peer.token, peer.user, false);
        break;
      }
      case 'D': {
        const conn = net.createConnection({ host: peer.host, port: peer.port });
        this.peers[peer.user] = new DistributedPeer(conn, peer);
        this.attachPeerLifecycle(peer.user, this.peers[peer.user]);
        break;
      }
      default: {
        const conn = net.createConnection({ host: peer.host, port: peer.port });
        if (peer.type === 'P') {
          conn.on('connect', () => {
            conn.write(MessageFactory.to.peer.peerInit(SLSK_USER, 'P', makePeerTokenHex()).getBuff());
          });
        }
        this.peers[peer.user] = new DefaultPeer(conn, peer);
        this.attachPeerLifecycle(peer.user, this.peers[peer.user]);
      }
    }
  }

  async ensureDownloadPeer(username) {
    if (this.peers[username]) return this.peers[username];
    const peer = await this.requestPeerAddress(username);
    this.connectToPeer({ ...peer, user: username, type: 'P' });
    return await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.peers[username]) {
          clearInterval(timer);
          resolve(this.peers[username]);
        } else if (Date.now() - started > 6000) {
          clearInterval(timer);
          reject(new Error(`Timed out connecting to peer ${username}`));
        }
      }, 100);
    });
  }

  async search(query, timeoutMs = 5000, limit = 10, filters = {}) {
    await this.ensureConnected();
    return await new Promise((resolve, reject) => {
      const token = crypto.randomBytes(4).toString('hex');
      const results = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const entry = stack.search[token];
        if (entry) entry.cb = () => {};
        resolve(results.slice(0, limit));
      };

      stack.search[token] = {
        query,
        cb: (res) => {
          if (settled || results.length >= limit) return;
          const filename = path.basename(String(res.file || '').replaceAll('\\', '/'));
          const extension = path.extname(filename).slice(1).toLowerCase();
          const bitrate = Number(res.bitrate || 0) || undefined;
          if (filters.format && extension !== String(filters.format).toLowerCase()) return;
          if (filters.minBitrate && (!bitrate || bitrate < filters.minBitrate)) return;
          results.push({
            user: res.user,
            file: res.file,
            filename,
            extension,
            size: res.size,
            sizeMb: formatSize(Number(res.size || 0)),
            slots: res.slots,
            bitrate,
            speed: res.speed
          });
          if (results.length >= limit) finish();
        }
      };
      setTimeout(() => {
        delete stack.search[token];
        finish();
      }, timeoutMs);
      try {
        this.sendServerMessage(26, (msg) => {
          msg.writeRawHexStr(token);
          msg.str(query);
        });
      } catch (error) {
        delete stack.search[token];
        settled = true;
        reject(error);
      }
    });
  }

  async localBrowseShares() {
    const directories = await buildLocalShareDirectories(DOWNLOAD_DIR);
    return {
      user: SLSK_USER,
      directoryCount: directories.length,
      fileCount: directories.reduce((sum, dir) => sum + dir.files.length, 0),
      directories: directories.slice(0, MAX_SHARE_RESULTS)
    };
  }

  async openPeerBrowseSocket(username) {
    const peerAddress = username === SLSK_USER
      ? { user: username, host: '127.0.0.1', port: INCOMING_PORT }
      : await this.requestPeerAddress(username);

    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: peerAddress.host, port: peerAddress.port });
      const msgs = new Messages();
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.on('error', fail);
      socket.on('data', (data) => msgs.write(data));
      socket.on('connect', () => {
        try {
          socket.write(MessageFactory.to.peer.peerInit(SLSK_USER, 'P', makePeerTokenHex()).getBuff());
          resolve({ socket, msgs, peerAddress });
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  async browseUserShares(username) {
    await this.ensureConnected();
    if (username === SLSK_USER) return await this.localBrowseShares();

    const { socket, msgs } = await this.openPeerBrowseSocket(username);
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Timed out browsing shares for ${username}`));
      }, 12000);

      const cleanup = () => clearTimeout(timeout);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };

      socket.on('error', fail);
      msgs.on('message', async (message) => {
        try {
          const size = message.read32();
          if (size <= 4) return;
          const code = message.read32();
          if (code !== 5) return;
          const payload = message.data.slice(message.pointer, size + 4);
          const directories = await parseSharedFileList(payload);
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy();
          resolve({
            user: username,
            directoryCount: directories.length,
            fileCount: directories.reduce((sum, dir) => sum + dir.files.length, 0),
            directories: directories.slice(0, MAX_SHARE_RESULTS)
          });
        } catch (error) {
          fail(error);
        }
      });

      const req = new Message();
      req.int32(4);
      socket.write(req.getBuff());
    });
  }

  async browseUserFolder(username, folder) {
    await this.ensureConnected();
    const normalizedFolder = normalizeSlskPath(folder);

    if (username === SLSK_USER) {
      const directories = filterFolderDirectories((await this.localBrowseShares()).directories, normalizedFolder);
      return { user: username, token: 0, folder: normalizedFolder, folders: directories };
    }

    const { socket, msgs } = await this.openPeerBrowseSocket(username);
    return await new Promise((resolve, reject) => {
      const ticket = crypto.randomInt(1, 0x7fffffff);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Timed out browsing folder ${normalizedFolder} for ${username}`));
      }, 12000);

      const cleanup = () => clearTimeout(timeout);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };

      socket.on('error', fail);
      msgs.on('message', async (message) => {
        try {
          const size = message.read32();
          if (size <= 4) return;
          const code = message.read32();
          if (code !== 37) return;
          const payload = message.data.slice(message.pointer, size + 4);
          const result = await parseFolderContents(payload);
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy();
          resolve({ user: username, ...result });
        } catch (error) {
          fail(error);
        }
      });

      const req = new Message();
      req.int32(36);
      req.int32(ticket);
      req.str(normalizedFolder);
      socket.write(req.getBuff());
    });
  }

  async queueDownload(username, file, outputSubdir = username) {
    await this.ensureConnected();
    const normalizedFile = normalizeSlskPath(file);
    const targetDir = path.join(DOWNLOAD_DIR, outputSubdir);
    await fs.mkdir(targetDir, { recursive: true });
    await this.ensureDownloadPeer(username);

    const localPath = path.join(targetDir, path.basename(normalizedFile.replaceAll('\\', '/')));
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      user: username,
      file: normalizedFile,
      localPath,
      status: 'queued',
      createdAt: nowIso()
    };
    this.downloads.set(jobId, job);

    return await new Promise((resolve, reject) => {
      stack.download[`${username}_${normalizedFile}`] = {
        cb: (error) => {
          if (error) {
            job.status = 'error';
            job.error = error.message;
            reject(error);
            return;
          }
          job.status = 'completed';
          job.completedAt = nowIso();
          resolve(job);
        },
        path: localPath,
        stream: null
      };

      const token = crypto.randomBytes(4).toString('hex');
      stack.downloadTokens[token] = { user: username, file: normalizedFile };
      job.token = token;
      job.status = 'requesting';
      this.peers[username].transferRequest(normalizedFile, token);

      setTimeout(() => {
        if (job.status === 'requesting') {
          job.status = 'queued';
          resolve(job);
        }
      }, 1500);
    });
  }

  listDownloads() {
    return Array.from(this.downloads.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async listRooms() {
    await this.ensureConnected();
    return await new Promise((resolve) => {
      this.pendingRoomLists.push({ resolve });
      this.sendServerMessage(64);
    });
  }

  async joinRoom(room) {
    await this.ensureConnected();
    return await new Promise((resolve) => {
      if (!this.pendingRoomJoins.has(room)) this.pendingRoomJoins.set(room, []);
      this.pendingRoomJoins.get(room).push({ resolve });
      this.sendServerMessage(14, (msg) => {
        msg.str(room);
        msg.int32(0);
      });
    });
  }

  async leaveRoom(room) {
    await this.ensureConnected();
    this.sendServerMessage(15, (msg) => msg.str(room));
    this.rooms.delete(room);
    return { room, left: true };
  }

  async sayRoom(room, message) {
    await this.ensureConnected();
    this.sendServerMessage(13, (msg) => {
      msg.str(room);
      msg.str(message);
    });
    appendLog(this.roomMessages, room, { room, username: SLSK_USER, message, at: nowIso(), direction: 'outbound' });
    return { room, sent: true };
  }

  listJoinedRooms() {
    return Array.from(this.rooms.values());
  }

  listRoomMessages(room, limit = 50) {
    return (this.roomMessages.get(room) || []).slice(-limit);
  }

  async sendPrivateMessage(username, message) {
    await this.ensureConnected();
    this.sendServerMessage(22, (msg) => {
      msg.str(username);
      msg.str(message);
    });
    appendLog(this.privateMessages, username, {
      username,
      message,
      direction: 'outbound',
      timestamp: Math.floor(Date.now() / 1000),
      at: nowIso()
    });
    return { username, sent: true };
  }

  listPrivateChats() {
    return Array.from(this.privateMessages.entries()).map(([username, messages]) => ({
      username,
      count: messages.length,
      lastMessage: messages[messages.length - 1]
    }));
  }

  listPrivateMessages(username, limit = 50) {
    return (this.privateMessages.get(username) || []).slice(-limit);
  }

  async watchUser(username) {
    await this.ensureConnected();
    return await new Promise((resolve) => {
      if (!this.pendingUserStatus.has(username)) this.pendingUserStatus.set(username, []);
      this.pendingUserStatus.get(username).push({ resolve });
      this.sendServerMessage(5, (msg) => msg.str(username));
    });
  }

  async listSavedFiles() {
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
    const walk = async (dir, prefix = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...await walk(full, rel));
        } else if (entry.isFile()) {
          const stat = await fs.stat(full);
          out.push({
            path: rel,
            size: stat.size,
            sizeMb: formatSize(stat.size),
            modifiedAt: stat.mtime.toISOString()
          });
        }
      }
      return out;
    };
    return (await walk(DOWNLOAD_DIR)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async readSavedFileInfo(relativePath) {
    const { safe, full } = resolveDownloadPath(relativePath);
    const stat = await fs.stat(full);
    return {
      path: safe,
      absolutePath: full,
      size: stat.size,
      sizeMb: formatSize(stat.size),
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString()
    };
  }

  async deleteSavedFile(relativePath) {
    const { safe, full } = resolveDownloadPath(relativePath);
    await fs.unlink(full);
    return { deleted: true, path: safe };
  }

  getDownloadFileUrl(relativePath) {
    const { safe } = resolveDownloadPath(relativePath);
    if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is not configured');
    return `${PUBLIC_BASE_URL}${FILES_PATH}/${safe.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(MCP_AUTH_TOKEN)}`;
  }

  async loadAutoJoinRooms() {
    try {
      const raw = await fs.readFile(AUTO_JOIN_ROOMS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      this.autoJoinRooms = Array.isArray(parsed.rooms) ? parsed.rooms.filter(Boolean) : [];
    } catch {
      this.autoJoinRooms = [];
    }
    return this.autoJoinRooms;
  }

  async saveAutoJoinRooms(rooms) {
    const unique = [...new Set(rooms.map((room) => String(room).trim()).filter(Boolean))];
    await fs.mkdir(path.dirname(AUTO_JOIN_ROOMS_FILE), { recursive: true });
    await fs.writeFile(AUTO_JOIN_ROOMS_FILE, JSON.stringify({ rooms: unique }, null, 2));
    this.autoJoinRooms = unique;
    return unique;
  }

  async autoJoinConfiguredRooms() {
    for (const room of this.autoJoinRooms) {
      try {
        await this.joinRoom(room);
      } catch {
      }
    }
  }

  async reconnect() {
    try {
      if (this.listen) this.listen.destroy();
    } catch {}
    try {
      if (this.serverSocket) this.serverSocket.destroy();
    } catch {}
    for (const peer of Object.values(this.peers)) {
      try { peer.destroy(); } catch {}
    }
    this.peers = {};
    this.connected = false;
    this.loginPromise = null;
    this.serverSocket = null;
    this.listen = null;
    await this.ensureConnected();
    await this.autoJoinConfiguredRooms();
    return this.health();
  }

  health() {
    return {
      connected: this.connected,
      user: SLSK_USER,
      server: `${SERVER_HOST}:${SERVER_PORT}`,
      rooms: this.rooms.size,
      privateChats: this.privateMessages.size,
      downloads: this.downloads.size,
      autoJoinRooms: this.autoJoinRooms,
      hostname: os.hostname(),
      version: APP_VERSION
    };
  }
}

const session = new SoulseekSession();

function buildMcpServer() {
const mcp = new McpServer({ name: 'soulseek-featured-mcp', version: APP_VERSION });

mcp.registerTool(
  'search_files',
  {
    description: 'Search Soulseek and return matching file metadata, with optional format and bitrate filters.',
    inputSchema: {
      query: z.string().min(1),
      timeoutMs: z.number().int().min(1000).max(20000).default(5000),
      limit: z.number().int().min(1).max(50).default(10),
      format: z.enum(['mp3', 'flac']).optional(),
      minBitrate: z.number().int().min(0).max(10000).optional()
    }
  },
  async ({ query, timeoutMs, limit, format, minBitrate }) => ({ structuredContent: { results: await session.search(query, timeoutMs, limit, { format, minBitrate }) } })
);

mcp.registerTool(
  'browse_user_shares',
  {
    description: 'Browse the full shared directory list of a Soulseek user.',
    inputSchema: { username: z.string().min(1) }
  },
  async ({ username }) => ({ structuredContent: await session.browseUserShares(username) })
);

mcp.registerTool(
  'browse_user_folder',
  {
    description: 'Browse one folder and its subfolders from a Soulseek user.',
    inputSchema: {
      username: z.string().min(1),
      folder: z.string().min(1)
    }
  },
  async ({ username, folder }) => ({ structuredContent: await session.browseUserFolder(username, folder) })
);

mcp.registerTool(
  'queue_download',
  {
    description: 'Queue or start downloading a Soulseek file to the server download directory.',
    inputSchema: {
      username: z.string().min(1),
      file: z.string().min(1),
      outputSubdir: z.string().min(1).default('downloads')
    }
  },
  async ({ username, file, outputSubdir }) => ({ structuredContent: await session.queueDownload(username, file, outputSubdir) })
);

mcp.registerTool(
  'list_downloads',
  {
    description: 'List current and past queued/downloaded files.',
    inputSchema: {}
  },
  async () => ({ structuredContent: { downloads: session.listDownloads() } })
);

mcp.registerTool(
  'list_saved_files',
  {
    description: 'List downloaded files currently stored on the server.',
    inputSchema: {}
  },
  async () => ({ structuredContent: { files: await session.listSavedFiles() } })
);

mcp.registerTool(
  'read_saved_file_info',
  {
    description: 'Read metadata for one saved downloaded file.',
    inputSchema: { path: z.string().min(1) }
  },
  async ({ path }) => ({ structuredContent: await session.readSavedFileInfo(path) })
);

mcp.registerTool(
  'delete_saved_file',
  {
    description: 'Delete one saved downloaded file from the server.',
    inputSchema: { path: z.string().min(1) }
  },
  async ({ path }) => ({ structuredContent: await session.deleteSavedFile(path) })
);

mcp.registerTool(
  'get_download_file_url',
  {
    description: 'Return a signed public URL for downloading a saved file over HTTP.',
    inputSchema: { path: z.string().min(1) }
  },
  async ({ path }) => ({ structuredContent: { path, url: session.getDownloadFileUrl(path) } })
);

mcp.registerTool(
  'list_rooms',
  {
    description: 'Fetch the global Soulseek room list.',
    inputSchema: {}
  },
  async () => ({ structuredContent: { rooms: await session.listRooms() } })
);

mcp.registerTool(
  'join_room',
  {
    description: 'Join a Soulseek room and cache its roster locally.',
    inputSchema: { room: z.string().min(1).max(24) }
  },
  async ({ room }) => ({ structuredContent: await session.joinRoom(room) })
);

mcp.registerTool(
  'leave_room',
  {
    description: 'Leave a Soulseek room.',
    inputSchema: { room: z.string().min(1) }
  },
  async ({ room }) => ({ structuredContent: await session.leaveRoom(room) })
);

mcp.registerTool(
  'say_room',
  {
    description: 'Send a message to a Soulseek room.',
    inputSchema: {
      room: z.string().min(1),
      message: z.string().min(1)
    }
  },
  async ({ room, message }) => ({ structuredContent: await session.sayRoom(room, message) })
);

mcp.registerTool(
  'list_joined_rooms',
  {
    description: 'List rooms currently joined by this MCP server session.',
    inputSchema: {}
  },
  async () => ({ structuredContent: { rooms: session.listJoinedRooms() } })
);

mcp.registerTool(
  'list_room_messages',
  {
    description: 'Read cached messages for a joined room.',
    inputSchema: {
      room: z.string().min(1),
      limit: z.number().int().min(1).max(200).default(50)
    }
  },
  async ({ room, limit }) => ({ structuredContent: { room, messages: session.listRoomMessages(room, limit) } })
);

mcp.registerTool(
  'send_private_message',
  {
    description: 'Send a private Soulseek message to a user.',
    inputSchema: {
      username: z.string().min(1),
      message: z.string().min(1)
    }
  },
  async ({ username, message }) => ({ structuredContent: await session.sendPrivateMessage(username, message) })
);

mcp.registerTool(
  'list_private_chats',
  {
    description: 'List cached private chat threads and latest messages.',
    inputSchema: {}
  },
  async () => ({ structuredContent: { chats: session.listPrivateChats() } })
);

mcp.registerTool(
  'list_private_messages',
  {
    description: 'Read cached messages for one private chat thread.',
    inputSchema: {
      username: z.string().min(1),
      limit: z.number().int().min(1).max(200).default(50)
    }
  },
  async ({ username, limit }) => ({ structuredContent: { username, messages: session.listPrivateMessages(username, limit) } })
);

mcp.registerTool(
  'watch_user',
  {
    description: 'Fetch and watch current status/stats for a Soulseek user.',
    inputSchema: { username: z.string().min(1) }
  },
  async ({ username }) => ({ structuredContent: await session.watchUser(username) })
);

mcp.registerTool(
  'get_auto_join_rooms',
  {
    description: 'Get the list of rooms configured to auto-join after restart/reconnect.',
    inputSchema: {}
  },
  async () => ({ structuredContent: { rooms: session.autoJoinRooms } })
);

mcp.registerTool(
  'set_auto_join_rooms',
  {
    description: 'Persist the list of rooms to auto-join after restart/reconnect.',
    inputSchema: { rooms: z.array(z.string().min(1)).max(100) }
  },
  async ({ rooms }) => ({ structuredContent: { rooms: await session.saveAutoJoinRooms(rooms) } })
);

mcp.registerTool(
  'reconnect_soulseek',
  {
    description: 'Reconnect the underlying Soulseek session and rejoin configured rooms.',
    inputSchema: {}
  },
  async () => ({ structuredContent: await session.reconnect() })
);

mcp.registerTool(
  'server_health',
  {
    description: 'Return MCP/Soulseek session health info.',
    inputSchema: {}
  },
  async () => ({ structuredContent: session.health() })
);

return mcp;
}

async function startHttp() {
  ensureEnv();
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  await session.loadAutoJoinRooms();
  await session.ensureConnected();
  await session.autoJoinConfiguredRooms();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(session.health(), null, 2));
      return;
    }

    if (url.pathname === '/' || url.pathname === DOCS_PATH) {
      const html = await fs.readFile(path.join(process.cwd(), 'docs.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname.startsWith(`${FILES_PATH}/`)) {
      const token = url.searchParams.get('token');
      const authOk = token === MCP_AUTH_TOKEN || req.headers.authorization === `Bearer ${MCP_AUTH_TOKEN}`;
      if (!authOk) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        const relativePath = decodeURIComponent(url.pathname.slice(FILES_PATH.length + 1));
        const { full } = resolveDownloadPath(relativePath);
        const stat = await fs.stat(full);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stat.size,
          'content-disposition': `attachment; filename="${path.basename(full)}"`
        });
        const stream = require('node:fs').createReadStream(full);
        stream.pipe(res);
      } catch (error) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${MCP_AUTH_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let parsedBody;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      parsedBody = body ? JSON.parse(body) : undefined;
    }

    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = buildMcpServer();
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      res.on('close', () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    }
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`Soulseek MCP HTTP listening on :${HTTP_PORT}${MCP_PATH}`);
  });
}

async function startStdio() {
  ensureEnv();
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  await session.loadAutoJoinRooms();
  await session.ensureConnected();
  await session.autoJoinConfiguredRooms();
  const transport = new StdioServerTransport();
  const mcp = buildMcpServer();
  await mcp.connect(transport);
}

async function main() {
  if (RUN_MODE === 'stdio') {
    await startStdio();
    return;
  }
  if (RUN_MODE === 'both') {
    await startHttp();
    return;
  }
  await startHttp();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
