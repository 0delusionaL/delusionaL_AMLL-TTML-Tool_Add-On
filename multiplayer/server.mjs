// Starts the multiplayer server: node multiplayer/server.mjs [--port 47800] [--dist dist]

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL_PORT } from "../src/modules/multiplayer/shared/protocol.js";
import { createMultiplayerServer } from "./server/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Whether a multiplayer server already answers on this port. @param {number} port */
export async function isOurServer(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/mp/info`, {
			signal: AbortSignal.timeout(1500),
		});
		const body = await res.json();
		return body?.app === "ttml-tool-multiplayer";
	} catch {
		return false;
	}
}

/**
 * @param {{ port?: number, distDir?: string, log?: (text: string) => void }} [options]
 * @returns {Promise<{ url: string, stop: () => Promise<void>, alreadyRunning: boolean }>}
 */
export async function runServer(options = {}) {
	const port = options.port ?? CONTROL_PORT;
	const log = options.log ?? ((text) => console.log(text));
	const server = createMultiplayerServer({
		distDir: options.distDir ?? resolve(here, "..", "dist"),
		controlPort: port,
		log,
	});
	try {
		await server.start();
	} catch (error) {
		if (/** @type {any} */ (error)?.code === "EADDRINUSE" && (await isOurServer(port))) {
			return { url: `http://localhost:${port}/`, stop: async () => {}, alreadyRunning: true };
		}
		throw error;
	}
	const url = `http://localhost:${server.controlPort}/`;
	log(`TTML Tool с мультиплеером запущен: ${url}`);
	log("Открой этот адрес в браузере, затем Правка → Мультиплеер → «Открыть для сети».");
	log("Не закрывай это окно, пока идёт пати. Для выхода нажми Ctrl+C.");
	return { url, stop: () => server.stop(), alreadyRunning: false };
}

function argValue(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const portArg = argValue("--port");
	const distArg = argValue("--dist");
	const running = await runServer({
		port: portArg ? Number(portArg) : undefined,
		distDir: distArg ? resolve(distArg) : undefined,
	}).catch((error) => {
		console.error(`Не удалось запустить сервер: ${error?.message ?? error}`);
		process.exit(1);
	});
	if (running.alreadyRunning) {
		console.log(`Сервер уже работает: ${running.url}`);
		process.exit(0);
	}
	const shutdown = async () => {
		await running.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
