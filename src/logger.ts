import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const logLevel = process.env.LOG_LEVEL || (isDev ? "debug" : "info");

export const logger = pino({
  level: logLevel,
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
          singleLine: true,
        },
      }
    : undefined,
});

export const httpLogger = logger.child({ module: "http" });
export const rpcLogger = logger.child({ module: "rpc" });
export const promptLogger = logger.child({ module: "prompt" });
export const sessionLogger = logger.child({ module: "session" });
export const approvalLogger = logger.child({ module: "approval" });
