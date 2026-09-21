/**
 * Process entrypoint.
 *
 * HTTP composition and adapter routing live in `server.ts`; keeping this
 * file intentionally small gives package scripts and external launchers a
 * stable entrypoint without making the OpenChamber adapter the process root.
 */
import "./server";
