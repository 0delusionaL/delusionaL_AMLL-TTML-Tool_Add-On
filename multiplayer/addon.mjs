// Installs, updates and removes the multiplayer add-on on a copy of the
// Spicy Lyrics TTML Tool. The editor stays the developers' own code: the
// add-on puts one folder into it (src/modules/multiplayer) and three small
// hooks into its files, and can take all of that out again.
//
//   node multiplayer/addon.mjs install [editor folder]
//   node multiplayer/addon.mjs update
//   node multiplayer/addon.mjs uninstall [--yes]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL_PORT } from "../src/modules/multiplayer/shared/protocol.js";
import { applyHooks, HOOKS, removeHooks } from "./hooks.mjs";
import { build as buildEditor, checkNodeVersion, describeHook } from "./launcher.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ADDON_ROOT = resolve(here, "..");
export const PAYLOAD = "src/modules/multiplayer";
export const UPSTREAM_URL = "https://github.com/spicylyrics/ttml-tool.git";
const MANIFEST = ".multiplayer-addon.json";
const CONFIG = "addon-config.json";
const EXCLUDES = [`/${PAYLOAD}/`, `/${MANIFEST}`];
// Files of the add-on that are not part of the editor build.
const SKIP = new Set(["hooks.test.ts"]);

// ------------------------------------------------------------------ helpers

function gitIn(root, progress = false) {
	return (args, { live = false } = {}) => {
		const result = spawnSync("git", args, {
			cwd: root,
			encoding: "utf8",
			windowsHide: true,
			stdio: live && progress ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
		});
		return {
			ok: result.status === 0,
			missing: Boolean(result.error),
			out: (result.stdout ?? "").trimEnd(),
			err: (result.stderr ?? "").trim(),
		};
	};
}

const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
};

export function readVersion(editorRoot) {
	return readJson(join(editorRoot, "package.json"))?.version ?? "?";
}

/** Where this add-on's editor lives: the folder chosen at install, or ./editor. */
export function readConfig(addonRoot = ADDON_ROOT) {
	const saved = readJson(join(addonRoot, CONFIG));
	const editor = typeof saved?.editor === "string" ? saved.editor : join(addonRoot, "editor");
	return { editor, managed: saved?.managed ?? editor === join(addonRoot, "editor") };
}

function writeConfig(addonRoot, config) {
	writeFileSync(join(addonRoot, CONFIG), `${JSON.stringify(config, null, "\t")}\n`);
}

export const isInstalled = (editorRoot) => existsSync(join(editorRoot, MANIFEST));

/** The folder looks like the TTML Tool: package.json and the three hooked files. */
export function isEditor(dir) {
	return existsSync(join(dir, "package.json")) && HOOKS.every((h) => existsSync(join(dir, h.file)));
}

function listFiles(root) {
	const out = [];
	const visit = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && !SKIP.has(entry.name)) out.push(relative(root, path));
		}
	};
	visit(root);
	return out;
}

/**
 * Makes the editor's copy of the multiplayer folder match the add-on's.
 * Only files that differ are written, so unchanged files keep their dates
 * and do not trigger a rebuild. @returns {boolean} whether anything changed
 */
export function syncPayload(addonRoot, editorRoot) {
	const from = join(addonRoot, PAYLOAD);
	const to = join(editorRoot, PAYLOAD);
	const wanted = listFiles(from);
	let changed = false;
	for (const file of wanted) {
		const source = readFileSync(join(from, file));
		const target = join(to, file);
		let current = null;
		try {
			current = readFileSync(target);
		} catch {
			// new file
		}
		if (current && current.equals(source)) continue;
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, source);
		changed = true;
	}
	const keep = new Set(wanted);
	for (const file of listFiles(to)) {
		if (!keep.has(file)) {
			rmSync(join(to, file), { force: true });
			changed = true;
		}
	}
	return changed;
}

/** Keeps the add-on's files out of the editor's git status. */
function setGitExcludes(editorRoot, present) {
	const file = join(editorRoot, ".git", "info", "exclude");
	if (!existsSync(join(editorRoot, ".git"))) return;
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		mkdirSync(dirname(file), { recursive: true });
	}
	const lines = text.split("\n").filter((line) => !EXCLUDES.includes(line));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (present) lines.push(...EXCLUDES);
	writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

async function defaultIsRunning() {
	const { isOurServer } = await import("./server.mjs");
	return isOurServer(CONTROL_PORT);
}

// ------------------------------------------------------------------ actions

/**
 * @param {{
 *   addonRoot?: string, editorRoot: string, managed: boolean,
 *   upstreamUrl?: string, build?: (root: string) => boolean,
 *   log?: (text: string) => void, progress?: boolean,
 * }} options
 */
export async function install(options) {
	const addonRoot = options.addonRoot ?? ADDON_ROOT;
	const editor = options.editorRoot;
	const log = options.log ?? console.log;
	const build = options.build ?? ((root) => buildEditor(root, log));
	if (!existsSync(editor)) {
		if (!options.managed) return { status: "blocked", reason: "not-found" };
		const git = gitIn(dirname(editor), options.progress);
		if (git(["--version"]).missing) return { status: "blocked", reason: "no-git" };
		log("Скачиваю редактор с GitHub разработчиков...");
		mkdirSync(dirname(editor), { recursive: true });
		const cloned = git(["clone", "--depth", "1", options.upstreamUrl ?? UPSTREAM_URL, editor], { live: true });
		if (!cloned.ok) return { status: "blocked", reason: "download", detail: cloned.err };
	}
	if (!isEditor(editor)) return { status: "blocked", reason: "not-editor" };
	syncPayload(addonRoot, editor);
	const broken = applyHooks(editor).filter((r) => !r.ok);
	if (broken.length > 0) {
		removeHooks(editor);
		rmSync(join(editor, PAYLOAD), { recursive: true, force: true });
		return { status: "blocked", reason: "hooks", hooks: broken };
	}
	setGitExcludes(editor, true);
	writeFileSync(join(editor, MANIFEST), `${JSON.stringify({ addon: "ttml-tool-multiplayer", managed: options.managed }, null, "\t")}\n`);
	log("Мультиплеер встроен. Собираю редактор...");
	const built = build(editor);
	return { status: "installed", built, version: readVersion(editor) };
}

/**
 * Takes the add-on out of the editor: hooks, the multiplayer folder, the
 * build made with it and the saved certificate.
 * @param {{ editorRoot: string, dataDir?: string, log?: (text: string) => void }} options
 */
export function uninstall(options) {
	const editor = options.editorRoot;
	if (!isInstalled(editor) && !existsSync(join(editor, PAYLOAD))) return { status: "not-installed" };
	const left = removeHooks(editor).filter((r) => !r.ok);
	rmSync(join(editor, PAYLOAD), { recursive: true, force: true });
	rmSync(join(editor, MANIFEST), { force: true });
	rmSync(join(editor, "dist"), { recursive: true, force: true });
	setGitExcludes(editor, false);
	if (options.dataDir) rmSync(options.dataDir, { recursive: true, force: true });
	return { status: "removed", left };
}

/**
 * Takes the developers' newest editor and attaches multiplayer to it again.
 * Anything that goes wrong leaves the previous version in place.
 * @param {{
 *   editorRoot: string, managed?: boolean, addonRoot?: string,
 *   build?: (root: string) => boolean, isRunning?: () => Promise<boolean>,
 *   log?: (text: string) => void, progress?: boolean,
 * }} options
 */
export async function updateEditor(options) {
	const editor = options.editorRoot;
	const addonRoot = options.addonRoot ?? ADDON_ROOT;
	const log = options.log ?? console.log;
	const build = options.build ?? ((root) => buildEditor(root, log));
	const isRunning = options.isRunning ?? defaultIsRunning;
	const blocked = (reason, extra = {}) => ({ status: "blocked", reason, ...extra });
	const managed = options.managed ?? readJson(join(editor, MANIFEST))?.managed === true;

	if (await isRunning()) return blocked("running");
	const git = gitIn(editor, options.progress);
	if (git(["--version"]).missing) return blocked("no-git");
	if (!existsSync(join(editor, ".git"))) return blocked("not-git");
	if (process.platform === "win32") git(["config", "core.filemode", "false"]);

	const reattach = () => {
		syncPayload(addonRoot, editor);
		return applyHooks(editor).filter((r) => !r.ok);
	};
	// With the hooks off, the editor should be exactly the developers' code.
	removeHooks(editor);
	const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out;
	if (dirty) {
		reattach();
		return blocked("dirty", { files: dirty.split("\n").map((line) => line.slice(3)) });
	}
	const before = git(["rev-parse", "HEAD"]).out;
	log("Скачиваю новую версию редактора...");
	if (managed) {
		const fetched = git(["fetch", "--depth", "1", "--no-tags", "origin", "main"], { live: true });
		if (!fetched.ok) {
			reattach();
			return blocked("download", { detail: fetched.err });
		}
		git(["reset", "-q", "--hard", "FETCH_HEAD"]);
	} else {
		const pulled = git(["pull", "--ff-only", "--no-rebase"], { live: true });
		if (!pulled.ok) {
			reattach();
			return blocked("pull", { detail: pulled.err || pulled.out });
		}
	}
	const after = git(["rev-parse", "HEAD"]).out;
	const restore = () => {
		git(["reset", "-q", "--hard", before]);
		reattach();
	};
	const broken = reattach();
	if (broken.length > 0) {
		restore();
		return blocked("hooks", { hooks: broken });
	}
	if (after === before) {
		syncPayload(addonRoot, editor);
		return { status: "up-to-date", version: readVersion(editor) };
	}
	if (!build(editor)) {
		log("Новая версия не собралась, возвращаю прежнюю...");
		restore();
		build(editor);
		return { status: "rolled-back", version: readVersion(editor) };
	}
	return { status: "updated", version: readVersion(editor) };
}

/** Pulls the add-on's own newest version when it was cloned with git. */
export function updateAddon(addonRoot = ADDON_ROOT, log = console.log) {
	const git = gitIn(addonRoot);
	if (!existsSync(join(addonRoot, ".git")) || git(["--version"]).missing) return { status: "skipped" };
	const before = git(["rev-parse", "HEAD"]).out;
	log("Проверяю новую версию аддона...");
	const pulled = git(["pull", "--ff-only", "--no-rebase"]);
	if (!pulled.ok) return { status: "failed", detail: pulled.err || pulled.out };
	return { status: git(["rev-parse", "HEAD"]).out === before ? "up-to-date" : "updated" };
}

// ------------------------------------------------------------------ messages

export function describe(result) {
	switch (result.status) {
		case "installed":
			return result.built
				? `Готово: мультиплеер встроен в редактор ${result.version}. Запускай Multiplayer.bat.`
				: "Мультиплеер встроен, но сборка не удалась. Проверь интернет и запусти Multiplayer.bat, он попробует собрать снова.";
		case "removed":
			return result.left?.length
				? `Мультиплеер удалён, но в этих файлах подключение пришлось оставить: ${result.left.map((h) => h.file).join(", ")}`
				: "Мультиплеер удалён. Редактор снова точно такой, как у разработчиков.";
		case "not-installed":
			return "Мультиплеер здесь не установлен.";
		case "updated":
			return `Готово: редактор обновлён до версии ${result.version}, мультиплеер на месте.`;
		case "up-to-date":
			return `У тебя последняя версия редактора (${result.version}).`;
		case "rolled-back":
			return "Новая версия не собралась, поэтому осталась прежняя. Попробуй обновиться позже.";
	}
	switch (result.reason) {
		case "running":
			return "Сначала закрой окно Multiplayer.bat, потом запусти это снова.";
		case "no-git":
			return "Не найден Git. Установи его с https://git-scm.com/download/win и запусти снова.";
		case "download":
			return `Не удалось скачать редактор. Проверь интернет.\n${result.detail ?? ""}`.trim();
		case "not-found":
			return "Такой папки нет.";
		case "not-editor":
			return "Это не папка Spicy Lyrics TTML Tool: в ней нет нужных файлов редактора.";
		case "not-git":
			return "Эта папка редактора скачана не через git, поэтому обновить её автоматически нельзя. Обнови редактор сам и запусти Install.bat снова.";
		case "dirty":
			return [
				"Обновление отменено, чтобы не потерять твои изменения в файлах редактора:",
				...result.files.map((file) => `  ${file}`),
			].join("\n");
		case "hooks":
			return [
				"В новую версию редактора мультиплеер пока не встраивается:",
				...result.hooks.map((hook) => `  ${describeHook(hook)} (${hook.file})`),
				"Обновление отменено, осталась прежняя версия, мультиплеер работает.",
			].join("\n");
		default:
			return `Не получилось: ${result.detail ?? result.reason}`;
	}
}

// ------------------------------------------------------------------ command line

async function confirm(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`${question} (да/нет) `)).trim().toLowerCase();
		return ["да", "д", "yes", "y"].includes(answer);
	} finally {
		rl.close();
	}
}

async function cli(argv) {
	const [command, ...rest] = argv;
	const node = checkNodeVersion();
	if (!node.ok && command !== "uninstall") {
		console.log(`Нужен Node.js ${node.required} или новее, сейчас стоит ${node.version}. Установи Node.js LTS с https://nodejs.org`);
		return 1;
	}
	const config = readConfig();
	if (command === "install") {
		const chosen = rest.find((arg) => !arg.startsWith("--"));
		const editorRoot = chosen ? resolve(chosen) : config.editor;
		const managed = chosen ? false : config.managed;
		const result = await install({ editorRoot, managed, progress: true });
		if (result.status === "installed") writeConfig(ADDON_ROOT, { editor: editorRoot, managed });
		console.log(describe(result));
		return result.status === "installed" && result.built ? 0 : 1;
	}
	if (command === "update") {
		const addon = updateAddon();
		if (addon.status === "updated") console.log("Аддон обновлён.");
		if (addon.status === "failed") console.log(`Аддон обновить не удалось: ${addon.detail}`);
		if (!isInstalled(config.editor)) {
			console.log("Мультиплеер ещё не установлен. Запусти Install.bat.");
			return 1;
		}
		const result = await updateEditor({ editorRoot: config.editor, managed: config.managed, progress: true });
		console.log(describe(result));
		return ["updated", "up-to-date"].includes(result.status) ? 0 : 1;
	}
	if (command === "uninstall") {
		if (!rest.includes("--yes") && !(await confirm("Удалить мультиплеер из редактора?"))) {
			console.log("Ничего не удалено.");
			return 0;
		}
		const { defaultDataDir } = await import("./server/app.mjs");
		const result = uninstall({ editorRoot: config.editor, dataDir: defaultDataDir() });
		console.log(describe(result));
		if (result.status === "removed" && config.managed) {
			console.log(`Сам редактор лежит в папке ${config.editor}. Если он больше не нужен, просто удали эту папку.`);
		}
		rmSync(join(ADDON_ROOT, CONFIG), { force: true });
		return 0;
	}
	console.log("Команды: install [папка редактора] | update | uninstall");
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	cli(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(`Ошибка: ${error?.message ?? error}`);
			process.exit(1);
		},
	);
}
