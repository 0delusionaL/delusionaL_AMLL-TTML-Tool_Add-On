// Multiplayer.bat runs this: check Node, keep the add-on attached to the
// editor, build the editor when its sources changed, start the server and
// open the browser.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyHooks } from "./hooks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ADDON_ROOT = resolve(here, "..");
const IS_WINDOWS = process.platform === "win32";
const STAMP = ".mp-build-stamp";
const PNPM_VERSION = "10.26.2";
const WATCHED_DIRS = ["src", "public"];
const WATCHED_FILES = [
	"package.json",
	"pnpm-lock.yaml",
	"index.html",
	"vite.config.ts",
	"tsconfig.json",
	"tsconfig.app.json",
];

const HOOK_LABELS = {
	"edit-menu": "пункт «Мультиплеер» в меню «Правка»",
	"title-bar": "вкладка «Чат» рядом с режимами редактора",
	"app-editor-slot": "показ чата на месте редактора",
};

/** Russian name of a hook for messages. @param {{ id: string, what?: string }} hook */
export const describeHook = (hook) => HOOK_LABELS[hook.id] ?? hook.what ?? hook.id;

/** Vite 7 needs Node 20.19+ or 22.12+. */
export function checkNodeVersion(version = process.versions.node) {
	const [major, minor] = version.split(".").map(Number);
	const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;
	return { ok, version, required: "20.19 / 22.12" };
}

/** Number of source files and the newest change among them. */
function fingerprint(root) {
	let count = 0;
	let newest = 0;
	const visit = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) {
				count++;
				newest = Math.max(newest, statSync(path).mtimeMs);
			}
		}
	};
	for (const dir of WATCHED_DIRS) visit(join(root, dir));
	for (const file of WATCHED_FILES) {
		const path = join(root, file);
		if (existsSync(path)) {
			count++;
			newest = Math.max(newest, statSync(path).mtimeMs);
		}
	}
	return { count, newest };
}

/** Whether dist/ is missing or older than the sources it was built from. */
export function needsBuild(root) {
	if (!existsSync(join(root, "dist", "index.html"))) return true;
	let stamp;
	try {
		stamp = JSON.parse(readFileSync(join(root, "dist", STAMP), "utf8"));
	} catch {
		return true;
	}
	const now = fingerprint(root);
	return now.count !== stamp.count || now.newest > stamp.newest;
}

export function markBuilt(root) {
	writeFileSync(join(root, "dist", STAMP), JSON.stringify(fingerprint(root)));
}

/** Whether node_modules is missing or older than the lockfile. */
export function needsInstall(root) {
	const marker = join(root, "node_modules", ".modules.yaml");
	if (!existsSync(marker)) return true;
	const installed = statSync(marker).mtimeMs;
	return ["pnpm-lock.yaml", "package.json"].some((file) => {
		const path = join(root, file);
		return existsSync(path) && statSync(path).mtimeMs > installed;
	});
}

const toolEnv = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/** Runs a command line tool; on Windows through the shell so .cmd shims work. */
function runTool(cmd, args, options) {
	if (IS_WINDOWS) {
		return spawnSync([cmd, ...args].join(" "), { ...options, shell: true, env: toolEnv });
	}
	return spawnSync(cmd, args, { ...options, env: toolEnv });
}

/** The command that runs pnpm here: pnpm itself, corepack, or npx. */
export function findPnpm(run = (cmd, args) => runTool(cmd, args, { stdio: "ignore" })) {
	const candidates = [["pnpm"], ["corepack", "pnpm"], ["npx", "--yes", `pnpm@${PNPM_VERSION}`]];
	for (const prefix of candidates) {
		const [cmd, ...rest] = prefix;
		if (run(cmd, [...rest, "--version"]).status === 0) return prefix;
	}
	return null;
}

function runPnpm(prefix, args, cwd) {
	const [cmd, ...rest] = prefix;
	return runTool(cmd, [...rest, ...args], { cwd, stdio: "inherit" }).status ?? 1;
}

/** Installs dependencies if needed and builds the editor. Returns true on success. */
export function build(root, log = console.log) {
	const pnpm = findPnpm((cmd, args) => runTool(cmd, args, { cwd: root, stdio: "ignore" }));
	if (!pnpm) {
		log("Не найден pnpm. Переустанови Node.js LTS с https://nodejs.org и запусти снова.");
		return false;
	}
	if (needsInstall(root)) {
		log("Устанавливаю зависимости (в первый раз это несколько минут)...");
		if (runPnpm(pnpm, ["install"], root) !== 0) {
			log("Не удалось установить зависимости. Проверь интернет и запусти снова.");
			return false;
		}
	}
	log("Собираю редактор...");
	if (runPnpm(pnpm, ["run", "build"], root) !== 0) {
		log("Сборка не удалась. Текст ошибки выше поможет понять, что сломалось.");
		return false;
	}
	markBuilt(root);
	return true;
}

function openBrowser(url) {
	try {
		const child = IS_WINDOWS
			? spawn("cmd", ["/c", "start", '""', url], { stdio: "ignore", detached: true, windowsVerbatimArguments: true })
			: spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// No browser to open; the address is printed anyway.
	}
}

function parseArgs(argv) {
	const value = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	return {
		port: value("--port") ? Number(value("--port")) : undefined,
		noBuild: argv.includes("--no-build"),
		rebuild: argv.includes("--rebuild"),
		noBrowser: argv.includes("--no-browser"),
	};
}

/** @returns {Promise<number | never>} exit code, or never while the server runs */
export async function main(argv = process.argv.slice(2), log = console.log) {
	const opts = parseArgs(argv);
	log("TTML Tool: мультиплеер");
	const node = checkNodeVersion();
	if (!node.ok) {
		log(`Нужен Node.js ${node.required} или новее, сейчас стоит ${node.version}. Установи Node.js LTS с https://nodejs.org`);
		return 1;
	}
	const { readConfig, syncPayload, isInstalled } = await import("./addon.mjs");
	const { editor } = readConfig(ADDON_ROOT);
	if (!isInstalled(editor)) {
		log("Мультиплеер ещё не установлен. Сначала запусти Install.bat.");
		return 1;
	}
	syncPayload(ADDON_ROOT, editor);
	for (const result of applyHooks(editor)) {
		if (!result.ok) {
			log(`Внимание: не получилось встроить ${describeHook(result)} (${result.file}). Редактор работает, но эта часть мультиплеера недоступна.`);
		} else if (result.changed) {
			log(`Восстановлено: ${describeHook(result)}.`);
		}
	}
	if (!opts.noBuild && (opts.rebuild || needsBuild(editor))) {
		if (!build(editor, log)) return 1;
	}
	const { runServer } = await import("./server.mjs");
	const running = await runServer({ port: opts.port, distDir: join(editor, "dist"), log });
	if (!opts.noBrowser) openBrowser(running.url);
	if (running.alreadyRunning) {
		log(`Сервер уже запущен в другом окне: ${running.url}`);
		return 0;
	}
	const stop = async () => {
		await running.stop();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	return new Promise(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error(`Ошибка: ${error?.message ?? error}`);
			process.exit(1);
		},
	);
}
