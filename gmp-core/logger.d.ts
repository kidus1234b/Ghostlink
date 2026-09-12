export default logger;
declare const logger: Logger;
declare class Logger {
    logsDir: string;
    _ensureLogsDir(): void;
    _getLogLevelValue(): any;
    _sanitizeAddress(addr: any, level: any): any;
    _sanitizeMeta(meta: any, level: any): {};
    log(level: any, component: any, event: any, msg: any, meta?: {}): void;
    _writeToLogFile(line: any): void;
    _pruneOldLogs(): void;
    trace(component: any, event: any, msg: any, meta: any): void;
    debug(component: any, event: any, msg: any, meta: any): void;
    info(component: any, event: any, msg: any, meta: any): void;
    warn(component: any, event: any, msg: any, meta: any): void;
    error(component: any, event: any, msg: any, meta: any): void;
    critical(component: any, event: any, msg: any, meta: any): void;
}
