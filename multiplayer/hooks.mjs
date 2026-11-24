// The three places where the editor's own files load multiplayer. Everything
// else lives in new files, so updates from the editor's developers merge
// cleanly. When an update touches one of these files, Update.bat takes the
// developers' version and puts the hook back with applyHooks.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE = "$/modules/multiplayer";

/** Adds `import { name } from MODULE;` after the file's last import. */
function addImport(src, name) {
	if (new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"\\$/modules/multiplayer"`).test(src)) {
		return src;
	}
	const lines = src.split("\n");
	let lastImportEnd = -1;
	let inImport = false;
	let inComment = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (inComment) {
			if (line.includes("*/")) inComment = false;
			continue;
		}
		if (inImport) {
			if (/;\s*$/.test(line) || /from\s+["'][^"']+["']\s*;?$/.test(line)) {
				inImport = false;
				lastImportEnd = i;
			}
			continue;
		}
		if (line === "" || line.startsWith("//")) continue;
		if (line.startsWith("/*")) {
			if (!line.includes("*/")) inComment = true;
			continue;
		}
		if (line.startsWith("import ") || line.startsWith("import{") || line === "import") {
			if (/;\s*$/.test(line) || /^import\s+["'][^"']+["']/.test(line) || /from\s+["'][^"']+["']\s*;?$/.test(line)) {
				lastImportEnd = i;
			} else {
				inImport = true;
			}
			continue;
		}
		break;
	}
	if (lastImportEnd < 0) return null;
	lines.splice(lastImportEnd + 1, 0, `import { ${name} } from "${MODULE}";`);
	return lines.join("\n");
}

const has = (src, name, marker) =>
	src.includes(marker) &&
	new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"\\$/modules/multiplayer"`).test(src);

/** Edit menu: the items list renders inside WithMultiplayerMenuItem. */
function applyEditMenu(src) {
	if (has(src, "WithMultiplayerMenuItem", "<WithMultiplayerMenuItem>")) return src;
	let out = null;
	const start = src.search(/const EditMenuItems\s*=\s*\(\)\s*=>\s*\{/);
	if (start >= 0) {
		const end = src.indexOf("\n};", start);
		const open = /return \(\s*<>/.exec(src.slice(start, end));
		if (open && end > 0) {
			const openAt = start + open.index + open[0].length - 2;
			const closeAt = src.lastIndexOf("</>", end);
			if (closeAt > openAt) {
				out =
					src.slice(0, openAt) +
					"<WithMultiplayerMenuItem>" +
					src.slice(openAt + 2, closeAt) +
					"</WithMultiplayerMenuItem>" +
					src.slice(closeAt + 3);
			}
		}
	}
	if (out === null && src.includes("<EditMenuItems />")) {
		// The list is defined some other way: wrap it where the menu renders it.
		out = src.replace(
			/<EditMenuItems \/>/g,
			"<WithMultiplayerMenuItem>\n<EditMenuItems />\n</WithMultiplayerMenuItem>",
		);
	}
	return out === null ? null : addImport(out, "WithMultiplayerMenuItem");
}

/** Title bar: the mode switch root becomes MultiplayerModeSwitch, same props. */
function applyTitleBar(src) {
	if (has(src, "MultiplayerModeSwitch", "<MultiplayerModeSwitch")) return src;
	const opens = [...src.matchAll(/<SegmentedControl\.Root\b/g)].map((m) => m.index ?? 0);
	const openAt =
		opens.find((i) => /value=\{toolMode\}/.test(src.slice(i, src.indexOf(">", i)))) ?? opens[0];
	if (openAt === undefined) return null;
	const closeAt = src.indexOf("</SegmentedControl.Root>", openAt);
	if (closeAt < 0) return null;
	const out =
		src.slice(0, openAt) +
		"<MultiplayerModeSwitch" +
		src.slice(openAt + "<SegmentedControl.Root".length, closeAt) +
		"</MultiplayerModeSwitch>" +
		src.slice(closeAt + "</SegmentedControl.Root>".length);
	return addImport(out, "MultiplayerModeSwitch");
}

/** App: the editor area is wrapped so the chat can take its place. */
function applyApp(src) {
	if (has(src, "MultiplayerEditorSlot", "<MultiplayerEditorSlot")) return src;
	const match = /\n(\t*)return editorContent;/.exec(src);
	if (!match) return null;
	const pad = match[1];
	const replacement =
		`\n${pad}return (\n` +
		`${pad}\t<MultiplayerEditorSlot key="editor-content">\n` +
		`${pad}\t\t{editorContent}\n` +
		`${pad}\t</MultiplayerEditorSlot>\n` +
		`${pad});`;
	const out = src.slice(0, match.index) + replacement + src.slice(match.index + match[0].length);
	return addImport(out, "MultiplayerEditorSlot");
}

/** Takes out the import line applyHooks added. */
function removeImport(src, name) {
	return src.replace(new RegExp(`\\nimport \\{ ${name} \\} from "\\$/modules/multiplayer";(?=\\n)`), "");
}

function removeEditMenu(src) {
	const out = src.includes("<WithMultiplayerMenuItem>\n<EditMenuItems />\n</WithMultiplayerMenuItem>")
		? src.replaceAll("<WithMultiplayerMenuItem>\n<EditMenuItems />\n</WithMultiplayerMenuItem>", "<EditMenuItems />")
		: src.replaceAll("<WithMultiplayerMenuItem>", "<>").replaceAll("</WithMultiplayerMenuItem>", "</>");
	return removeImport(out, "WithMultiplayerMenuItem");
}

function removeTitleBar(src) {
	const out = src
		.replaceAll("<MultiplayerModeSwitch", "<SegmentedControl.Root")
		.replaceAll("</MultiplayerModeSwitch>", "</SegmentedControl.Root>");
	return removeImport(out, "MultiplayerModeSwitch");
}

function removeApp(src) {
	const out = src.replace(
		/\n(\t*)return \(\n\t*<MultiplayerEditorSlot key="editor-content">\n\t*\{editorContent\}\n\t*<\/MultiplayerEditorSlot>\n\t*\);/,
		"\n$1return editorContent;",
	);
	return removeImport(out, "MultiplayerEditorSlot");
}

export const HOOKS = [
	{
		id: "edit-menu",
		file: "src/components/TopMenu/modals/EditMenu.tsx",
		what: "Multiplayer item at the end of the Edit menu",
		check: (src) => has(src, "WithMultiplayerMenuItem", "<WithMultiplayerMenuItem>"),
		apply: applyEditMenu,
		remove: removeEditMenu,
	},
	{
		id: "title-bar",
		file: "src/components/TitleBar/index.tsx",
		what: "Chat tab after Edit / Time / Preview",
		check: (src) => has(src, "MultiplayerModeSwitch", "<MultiplayerModeSwitch"),
		apply: applyTitleBar,
		remove: removeTitleBar,
	},
	{
		id: "app-editor-slot",
		file: "src/App.tsx",
		what: "chat shown in place of the editor",
		check: (src) => has(src, "MultiplayerEditorSlot", "<MultiplayerEditorSlot"),
		apply: applyApp,
		remove: removeApp,
	},
];

/** @param {string} id @param {string} src @returns {string | null} */
export function applyHookToSource(id, src) {
	const hook = HOOKS.find((h) => h.id === id);
	if (!hook) throw new Error(`unknown hook ${id}`);
	return hook.apply(src);
}

/** @param {string} id @param {string} src @returns {string} the file without the hook */
export function removeHookFromSource(id, src) {
	const hook = HOOKS.find((h) => h.id === id);
	if (!hook) throw new Error(`unknown hook ${id}`);
	return hook.remove(src);
}

/** Puts the editor's files back as they were before applyHooks. @param {string} root */
export function removeHooks(root) {
	return HOOKS.map((h) => {
		const path = join(root, h.file);
		let src;
		try {
			src = readFileSync(path, "utf8");
		} catch {
			return { id: h.id, file: h.file, what: h.what, ok: true, changed: false };
		}
		const out = h.remove(src);
		const ok = !h.check(out);
		if (ok && out !== src) writeFileSync(path, out);
		return { id: h.id, file: h.file, what: h.what, ok, changed: ok && out !== src };
	});
}

/** @param {string} root */
export function checkHooks(root) {
	return HOOKS.map((h) => {
		let ok = false;
		try {
			ok = h.check(readFileSync(join(root, h.file), "utf8"));
		} catch {
			ok = false;
		}
		return { id: h.id, file: h.file, what: h.what, ok };
	});
}

/** @param {string} root @param {{ only?: string[], write?: boolean }} [options] */
export function applyHooks(root, options = {}) {
	return HOOKS.filter((h) => !options.only || options.only.includes(h.file) || options.only.includes(h.id)).map(
		(h) => {
			const path = join(root, h.file);
			let src;
			try {
				src = readFileSync(path, "utf8");
			} catch {
				return { id: h.id, file: h.file, what: h.what, ok: false, changed: false };
			}
			const out = h.apply(src);
			if (out === null) return { id: h.id, file: h.file, what: h.what, ok: false, changed: false };
			const changed = out !== src;
			if (changed && options.write !== false) writeFileSync(path, out);
			return { id: h.id, file: h.file, what: h.what, ok: true, changed };
		},
	);
}

// node multiplayer/hooks.mjs          puts missing hooks back
// node multiplayer/hooks.mjs --check  only reports, exit code 1 if one is missing
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const results = process.argv.includes("--check") ? checkHooks(root) : applyHooks(root);
	for (const r of results) {
		const state = !r.ok ? "MISSING" : r.changed ? "restored" : "ok";
		console.log(`${state.padEnd(8)} ${r.id.padEnd(16)} ${r.file}`);
	}
	process.exit(results.every((r) => r.ok) ? 0 : 1);
}
