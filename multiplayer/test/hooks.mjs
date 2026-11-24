import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyHookToSource, applyHooks, checkHooks, HOOKS, removeHookFromSource, removeHooks } from "../hooks.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures");
const VERSIONS = ["0.23.0", "0.24.1"];
/** The editor's own file, as released (no hooks). */
const pristine = (file, version = "0.23.0") => readFileSync(join(FIXTURES, version, file.replaceAll("/", "_")), "utf8");
const hook = (id) => HOOKS.find((h) => h.id === id);

test("each hook applies to the editor's original files", () => {
	for (const h of HOOKS) {
		const out = applyHookToSource(h.id, pristine(h.file));
		assert.ok(out, `${h.id} did not apply`);
		assert.ok(h.check(out), `${h.id} check fails after apply`);
		assert.ok(out.includes('from "$/modules/multiplayer";'), `${h.id} import missing`);
	}
});

test("applying twice changes nothing", () => {
	for (const h of HOOKS) {
		const once = applyHookToSource(h.id, pristine(h.file));
		assert.equal(applyHookToSource(h.id, once), once);
	}
});

test("Multiplayer stays after items the editor adds later", () => {
	const src = pristine(hook("edit-menu").file).replace(
		"{item(MENU_ACTIONS.preferences)}",
		"{item(MENU_ACTIONS.preferences)}\n\t\t\t<DropdownMenu.Separator />\n\t\t\t{item(MENU_ACTIONS.brandNewThing)}",
	);
	const out = applyHookToSource("edit-menu", src);
	const close = out.indexOf("</WithMultiplayerMenuItem>");
	assert.ok(close > out.indexOf("brandNewThing"));
});

test("edit menu falls back to wrapping the item list where it is used", () => {
	const src = pristine(hook("edit-menu").file).replace("const EditMenuItems = () => {", "function EditMenuItems() {").replace(/\n\t\t<\/>\n\t\);\n};/, "\n\t\t</>\n\t);\n}");
	const out = applyHookToSource("edit-menu", src);
	assert.ok(out);
	assert.equal((out.match(/<WithMultiplayerMenuItem>/g) ?? []).length >= 1, true);
	assert.ok(hook("edit-menu").check(out));
});

test("title bar hook survives new props on the mode switch", () => {
	const src = pristine(hook("title-bar").file).replace(
		"<SegmentedControl.Root\n",
		'<SegmentedControl.Root\n\t\t\t\t\tdata-new-prop="x"\n',
	);
	const out = applyHookToSource("title-bar", src);
	assert.ok(out.includes("<MultiplayerModeSwitch\n"));
	assert.ok(out.includes("</MultiplayerModeSwitch>"));
	assert.ok(!out.includes("<SegmentedControl.Root"));
	assert.ok(out.includes("<SegmentedControl.Item"), "items stay as they are");
});

test("a hook that cannot find its place reports it", () => {
	const out = applyHookToSource("app-editor-slot", "export default function App() { return null; }\n");
	assert.equal(out, null);
});

test("checkHooks and applyHooks work on a copy of the repo files", () => {
	const dir = mkdtempSync(join(tmpdir(), "mp-hooks-"));
	try {
		for (const h of HOOKS) {
			const target = join(dir, h.file);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, pristine(h.file));
		}
		assert.ok(checkHooks(dir).every((r) => !r.ok));
		const results = applyHooks(dir);
		assert.ok(results.every((r) => r.ok && r.changed));
		assert.ok(checkHooks(dir).every((r) => r.ok));
		assert.ok(applyHooks(dir).every((r) => r.ok && !r.changed));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hooks apply to every known editor release and come off without a trace", () => {
	for (const version of VERSIONS) {
		for (const h of HOOKS) {
			const original = pristine(h.file, version);
			const hooked = applyHookToSource(h.id, original);
			assert.ok(hooked && h.check(hooked), `${h.id} on ${version}`);
			assert.equal(removeHookFromSource(h.id, hooked), original, `${h.id} on ${version} removes cleanly`);
			assert.equal(removeHookFromSource(h.id, original), original, `${h.id} on ${version} without hook`);
		}
	}
});

test("removeHooks restores the files on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "mp-unhook-"));
	try {
		for (const h of HOOKS) {
			const target = join(dir, h.file);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, pristine(h.file, "0.24.1"));
		}
		applyHooks(dir);
		const results = removeHooks(dir);
		assert.ok(results.every((r) => r.ok && r.changed));
		for (const h of HOOKS) assert.equal(readFileSync(join(dir, h.file), "utf8"), pristine(h.file, "0.24.1"));
		assert.ok(removeHooks(dir).every((r) => r.ok && !r.changed));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
