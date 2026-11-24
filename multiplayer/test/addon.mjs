import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { install, PAYLOAD, syncPayload, uninstall, updateEditor } from "../addon.mjs";
import { checkHooks, HOOKS } from "../hooks.mjs";

const ADDON = join(import.meta.dirname, "../..");
const FIXTURES = join(import.meta.dirname, "fixtures", "0.24.1");
const quiet = () => {};
const ok = () => true;
const notRunning = async () => false;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function write(root, file, text) {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), text);
}

/** The editor as its developers publish it: the three hooked files and a package.json. */
function editorFiles(root, version = "0.24.1") {
	for (const h of HOOKS) write(root, h.file, readFileSync(join(FIXTURES, h.file.replaceAll("/", "_")), "utf8"));
	write(root, "package.json", `{ "name": "amll-ttml-tool", "version": "${version}" }\n`);
	write(root, ".gitignore", "node_modules/\ndist\n");
}

function upstreamRepo(dir) {
	const up = join(dir, "upstream");
	mkdirSync(up);
	git(up, "init", "-q", "-b", "main");
	git(up, "config", "user.email", "dev@example.com");
	git(up, "config", "user.name", "Dev");
	editorFiles(up);
	git(up, "add", "-A");
	git(up, "commit", "-q", "-m", "release 0.24.1");
	return up;
}

const commitUpstream = (up, file, edit, message) => {
	write(up, file, edit(existsSync(join(up, file)) ? readFileSync(join(up, file), "utf8") : ""));
	git(up, "add", "-A");
	git(up, "commit", "-q", "-m", message);
};

/** Every file under root with its content, for before/after comparisons. */
function snapshot(root) {
	const out = {};
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else out[relative(root, path)] = readFileSync(path, "utf8");
		}
	};
	visit(root);
	return out;
}

async function installedEditor(t) {
	const dir = mkdtempSync(join(tmpdir(), "mp-addon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const up = upstreamRepo(dir);
	const editor = join(dir, "editor");
	const result = await install({ editorRoot: editor, managed: true, upstreamUrl: `file://${up}`, log: quiet, build: ok });
	assert.equal(result.status, "installed");
	return { dir, up, editor };
}

test("install downloads the editor and attaches multiplayer to it", async (t) => {
	const { editor } = await installedEditor(t);
	assert.ok(checkHooks(editor).every((r) => r.ok));
	assert.ok(existsSync(join(editor, PAYLOAD, "index.ts")));
	assert.ok(!existsSync(join(editor, PAYLOAD, "hooks.test.ts")));
	const changed = git(editor, "status", "--porcelain").trimEnd().split("\n").map((l) => l.slice(3)).sort();
	assert.deepEqual(changed, HOOKS.map((h) => h.file).sort(), "only the hooked lines show up in git");
});

test("uninstall leaves the downloaded editor exactly as its developers publish it", async (t) => {
	const { dir, editor } = await installedEditor(t);
	mkdirSync(join(editor, "dist"));
	writeFileSync(join(editor, "dist", "index.html"), "built with multiplayer");
	const dataDir = join(dir, "data");
	mkdirSync(dataDir);
	writeFileSync(join(dataDir, "lan-certificate.json"), "{}");
	const result = uninstall({ editorRoot: editor, dataDir, log: quiet });
	assert.equal(result.status, "removed");
	assert.equal(git(editor, "status", "--porcelain", "--ignored").trim(), "");
	assert.ok(!existsSync(dataDir));
	assert.equal(uninstall({ editorRoot: editor, dataDir, log: quiet }).status, "not-installed");
});

test("install attaches to an editor folder you already have, and uninstall puts it back", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mp-addon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const editor = join(dir, "My TTML Tool");
	editorFiles(editor);
	write(editor, "src/other.ts", "export const mine = 1;\n");
	const before = snapshot(editor);
	const result = await install({ editorRoot: editor, managed: false, log: quiet, build: ok });
	assert.equal(result.status, "installed");
	assert.ok(checkHooks(editor).every((r) => r.ok));
	assert.equal(uninstall({ editorRoot: editor, dataDir: join(dir, "none"), log: quiet }).status, "removed");
	assert.deepEqual(snapshot(editor), before);
});

test("install refuses a folder that is not the editor", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mp-addon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	write(dir, "readme.txt", "hello");
	const result = await install({ editorRoot: dir, managed: false, log: quiet, build: ok });
	assert.equal(result.status, "blocked");
	assert.equal(result.reason, "not-editor");
	assert.ok(!existsSync(join(dir, PAYLOAD)));
});

test("a failed first build still leaves multiplayer attached", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mp-addon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const up = upstreamRepo(dir);
	const editor = join(dir, "editor");
	const result = await install({ editorRoot: editor, managed: true, upstreamUrl: `file://${up}`, log: quiet, build: () => false });
	assert.equal(result.status, "installed");
	assert.equal(result.built, false);
	assert.ok(checkHooks(editor).every((r) => r.ok));
});

test("a new editor version is taken and multiplayer attached to it again", async (t) => {
	const { up, editor } = await installedEditor(t);
	commitUpstream(up, "src/App.tsx", (src) => src.replace("function App() {", "function App() {\n\tconst brandNew = 1;"), "change App");
	commitUpstream(up, "src/new-feature.ts", () => "export const x = 1;\n", "feature");
	commitUpstream(up, "package.json", () => '{ "name": "amll-ttml-tool", "version": "0.25.0" }\n', "release 0.25.0");
	const result = await updateEditor({ editorRoot: editor, log: quiet, build: ok, isRunning: notRunning });
	assert.equal(result.status, "updated");
	assert.equal(result.version, "0.25.0");
	assert.ok(readFileSync(join(editor, "src/App.tsx"), "utf8").includes("brandNew"));
	assert.ok(existsSync(join(editor, "src/new-feature.ts")));
	assert.ok(checkHooks(editor).every((r) => r.ok));
	assert.ok(existsSync(join(editor, PAYLOAD, "index.ts")));
	assert.equal((await updateEditor({ editorRoot: editor, log: quiet, build: ok, isRunning: notRunning })).status, "up-to-date");
});

test("a version multiplayer cannot attach to is not taken", async (t) => {
	const { up, editor } = await installedEditor(t);
	const head = git(editor, "rev-parse", "HEAD").trim();
	commitUpstream(up, "src/components/TitleBar/index.tsx", (src) => src.replaceAll("SegmentedControl.Root", "ModeTabs"), "new mode switch");
	const result = await updateEditor({ editorRoot: editor, log: quiet, build: ok, isRunning: notRunning });
	assert.equal(result.status, "blocked");
	assert.equal(result.reason, "hooks");
	assert.deepEqual(result.hooks.map((h) => h.id), ["title-bar"]);
	assert.equal(git(editor, "rev-parse", "HEAD").trim(), head);
	assert.ok(checkHooks(editor).every((r) => r.ok));
});

test("a new version that does not build is rolled back", async (t) => {
	const { up, editor } = await installedEditor(t);
	const head = git(editor, "rev-parse", "HEAD").trim();
	commitUpstream(up, "package.json", () => '{ "name": "amll-ttml-tool", "version": "0.26.0" }\n', "release");
	const versions = [];
	const build = (root) => {
		versions.push(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
		return versions.length > 1;
	};
	const result = await updateEditor({ editorRoot: editor, log: quiet, build, isRunning: notRunning });
	assert.equal(result.status, "rolled-back");
	assert.deepEqual(versions, ["0.26.0", "0.24.1"]);
	assert.equal(git(editor, "rev-parse", "HEAD").trim(), head);
	assert.ok(checkHooks(editor).every((r) => r.ok));
});

test("the update waits until Multiplayer.bat is closed", async (t) => {
	const { editor } = await installedEditor(t);
	const result = await updateEditor({ editorRoot: editor, log: quiet, build: ok, isRunning: async () => true });
	assert.equal(result.reason, "running");
});

test("your own edits in the editor block the update", async (t) => {
	const { up, editor } = await installedEditor(t);
	commitUpstream(up, "package.json", () => '{ "name": "amll-ttml-tool", "version": "0.27.0" }\n', "release");
	write(editor, "package.json", '{ "name": "amll-ttml-tool", "version": "mine" }\n');
	const result = await updateEditor({ editorRoot: editor, log: quiet, build: ok, isRunning: notRunning });
	assert.equal(result.reason, "dirty");
	assert.deepEqual(result.files, ["package.json"]);
	assert.ok(checkHooks(editor).every((r) => r.ok));
});

test("an editor you cloned yourself is fast-forwarded", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mp-addon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const up = upstreamRepo(dir);
	git(dir, "clone", "-q", up, "mine");
	const editor = join(dir, "mine");
	assert.equal((await install({ editorRoot: editor, managed: false, log: quiet, build: ok })).status, "installed");
	commitUpstream(up, "package.json", () => '{ "name": "amll-ttml-tool", "version": "0.28.0" }\n', "release");
	const result = await updateEditor({ editorRoot: editor, log: quiet, build: ok, isRunning: notRunning });
	assert.equal(result.status, "updated");
	assert.equal(result.version, "0.28.0");
	assert.equal(git(editor, "rev-parse", "--is-shallow-repository").trim(), "false");
});

test("payload sync copies only what changed and drops files the add-on no longer has", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mp-addon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(syncPayload(ADDON, dir), true);
	const index = join(dir, PAYLOAD, "index.ts");
	const mtime = statSync(index).mtimeMs;
	assert.equal(syncPayload(ADDON, dir), false);
	assert.equal(statSync(index).mtimeMs, mtime);
	write(dir, `${PAYLOAD}/old-file.ts`, "export {};\n");
	assert.equal(syncPayload(ADDON, dir), true);
	assert.ok(!existsSync(join(dir, PAYLOAD, "old-file.ts")));
});
