import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import type { LogLevel, LogMeta } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LEVELS: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  CRITICAL: 5,
};

class Logger {
  private logsDir: string;

  constructor() {
    this.logsDir = path.join(process.cwd(), 'gmp-core', 'data', 'logs');
    this._ensureLogsDir();
  }

  private _ensureLogsDir(): void {
    try {
      if (config.GMP_LOG_TO_FILE && !fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
    } catch {
      config.GMP_LOG_TO_FILE = false;
    }
  }

  private _getLogLevelValue(): number {
    const levelStr = (config.GMP_LOG_LEVEL || 'INFO').toUpperCase() as LogLevel;
    return LEVELS[levelStr] ?? LEVELS.INFO;
  }

  private _sanitizeAddress(addr: string, level: LogLevel): string {
    if (!addr) return addr;
    if (level === 'DEBUG' || level === 'TRACE') return addr;

    if (addr.includes('.')) {
      const parts = addr.split('.');
      if (parts.length >= 3) {
        return parts.slice(0, 3).join('.') + '.x';
      }
    }
    if (addr.includes(':')) {
      const parts = addr.split(':');
      if (parts.length >= 3) {
        return parts.slice(0, 3).join(':') + ':x';
      }
    }
    return addr;
  }

  private _sanitizeMeta(meta: LogMeta | undefined, level: LogLevel): LogMeta | undefined {
    if (!meta) return undefined;
    const clean: LogMeta = {};
    const sensitiveKeys = [
      'payload', 'message', 'data', 'bytes', 'seed', 'seedPhrase',
      'privateKey', 'privKey', 'sessionKey', 'key', 'sharedSecret',
      'wrappedKey', 'wrappedPrivKey', 'cert', 'signature', 'staticPubkey', 'signingPubkey'
    ];

    for (const [k, v] of Object.entries(meta)) {
      if (sensitiveKeys.some(sk => k.toLowerCase().includes(sk.toLowerCase()))) {
        clean[k] = '[REDACTED]';
        continue;
      }
      if (k === 'address' || k === 'ip') {
        clean[k] = this._sanitizeAddress(String(v), level);
      } else if (k === 'nodeId' || k === 'peerNodeId' || k === 'destinationNodeId' || k === 'sourceNodeId' || k === 'targetNodeId' || k === 'bannedNodeId') {
        if (typeof v === 'string') {
          clean[k] = (level === 'DEBUG' || level === 'TRACE') ? v : v.slice(0, 16);
        } else {
          clean[k] = v;
        }
      } else if (v instanceof Error) {
        clean[k] = v.message;
      } else if (typeof v === 'object' && v !== null) {
        clean[k] = this._sanitizeMeta(v as LogMeta, level);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

  log(level: LogLevel, component: string, event: string, msg: string, meta: LogMeta = {}): void {
    const currentVal = this._getLogLevelValue();
    const msgVal = LEVELS[level];

    if (msgVal < currentVal) return;

    const ts = new Date().toISOString();
    const logObj: Record<string, unknown> = {
      ts,
      level,
      component,
      event,
      msg,
    };

    if (meta && (meta.nodeId || meta.peerNodeId)) {
      const nid = (meta.nodeId || meta.peerNodeId) as string;
      logObj.nodeId = (level === 'DEBUG' || level === 'TRACE') ? nid : nid.slice(0, 16);
    }
    if (meta && (meta.address || meta.ip)) {
      logObj.address = this._sanitizeAddress(String(meta.address || meta.ip), level);
    }

    const cleanMeta = this._sanitizeMeta(meta, level);
    if (cleanMeta && Object.keys(cleanMeta).length > 0) {
      logObj.meta = cleanMeta;
    }

    const logLine = JSON.stringify(logObj);

    if (config.GMP_LOG_TO_CONSOLE) {
      if (level === 'ERROR' || level === 'CRITICAL') {
        console.error(logLine);
      } else if (level === 'WARN') {
        console.warn(logLine);
      } else {
        console.log(logLine);
      }
    }

    if (config.GMP_LOG_TO_FILE) {
      this._writeToLogFile(logLine);
    }
  }

  private _writeToLogFile(line: string): void {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(this.logsDir, `gmp-${today}.log`);
      this._ensureLogsDir();
      fs.appendFileSync(logFile, line + '\n', 'utf8');

      if (Math.random() < 0.05) {
        this._pruneOldLogs();
      }
    } catch {
      // Ignore file writing errors
    }
  }

  private _pruneOldLogs(): void {
    try {
      if (!fs.existsSync(this.logsDir)) return;
      const files = fs.readdirSync(this.logsDir);
      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.startsWith('gmp-') && file.endsWith('.log')) {
          const filePath = path.join(this.logsDir, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch {
      // Ignore pruning errors
    }
  }

  trace(component: string, event: string, msg: string, meta?: LogMeta): void {
    this.log('TRACE', component, event, msg, meta);
  }

  debug(component: string, event: string, msg: string, meta?: LogMeta): void {
    this.log('DEBUG', component, event, msg, meta);
  }

  info(component: string, event: string, msg: string, meta?: LogMeta): void {
    this.log('INFO', component, event, msg, meta);
  }

  warn(component: string, event: string, msg: string, meta?: LogMeta): void {
    this.log('WARN', component, event, msg, meta);
  }

  error(component: string, event: string, msg: string, meta?: LogMeta): void {
    this.log('ERROR', component, event, msg, meta);
  }

  critical(component: string, event: string, msg: string, meta?: LogMeta): void {
    this.log('CRITICAL', component, event, msg, meta);
  }
}

const logger = new Logger();
export default logger;
export { Logger, LEVELS };