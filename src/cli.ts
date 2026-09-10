import { parseArgs } from "node:util";
import { validateOmpBinary } from "./providers/omp/binary";

export interface SidecarCliOptions {
  binary?: string;
  port?: number;
  help?: boolean;
}

/**
 * Parse CLI options for the OMP sidecar.
 * Supports:
 *   -b, --binary <path>      Path to custom OMP binary (aliases: --omp-bin, --omp-binary)
 *   -p, --port <port>        Port to listen on
 *   -h, --help               Show help message
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): SidecarCliOptions {
  // Strip leading "--" if invoked via `bun run start -- ...` or `npm start -- ...`
  const args = argv[0] === "--" ? argv.slice(1) : argv;

  const { values } = parseArgs({
    args,
    options: {
      binary: { type: "string", short: "b" },
      "omp-bin": { type: "string" },
      "omp-binary": { type: "string" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
  });

  const rawBinary = values.binary || values["omp-binary"] || values["omp-bin"];
  let binary: string | undefined;
  if (typeof rawBinary === "string" && rawBinary.trim()) {
    binary = validateOmpBinary(rawBinary.trim());
  }

  let port: number | undefined;
  if (typeof values.port === "string" && values.port.trim()) {
    const parsedPort = Number(values.port.trim());
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`Invalid port: ${values.port}. Port must be an integer between 1 and 65535.`);
    }
    port = parsedPort;
  }

  return {
    binary,
    port,
    help: Boolean(values.help),
  };
}

export function printHelp(): void {
  console.log(`OpenChamber OMP Sidecar

Usage:
  bun run src/main.ts [options]
  bun run start -- [options]

Options:
  -b, --binary <path>       Path to custom OMP binary (aliases: --omp-bin, --omp-binary)
  -p, --port <port>         Port to listen on (default: 4096, or OC_SIDECAR_PORT)
  -h, --help                Show this help message

Environment Variables:
  OMP_BIN                   Path to custom OMP binary
  OC_SIDECAR_PORT           Port to listen on
`);
}
