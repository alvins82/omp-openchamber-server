import pino from "pino";
import pretty from "pino-pretty";

const isDev = process.env.NODE_ENV !== "production";
const logLevel = process.env.LOG_LEVEL || "info";

const prettyStream = isDev
  ? pretty({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname",
      singleLine: true,
    })
  : undefined;

export const logger = prettyStream
  ? pino({ level: logLevel }, prettyStream)
  : pino({ level: logLevel });

export const httpLogger = logger.child({ module: "http" });
export const rpcLogger = logger.child({ module: "rpc" });
export const promptLogger = logger.child({ module: "prompt" });
export const sessionLogger = logger.child({ module: "session" });
export const approvalLogger = logger.child({ module: "approval" });
