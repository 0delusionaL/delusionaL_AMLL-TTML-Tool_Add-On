import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	checkNodeVersion,
	findPnpm,
	markBuilt,
	needsBuild,
	needsInstall,
} from "../launcher.mjs";

test("node version check follows Vite's requirement", () => {
	assert.equal(checkNodeVersion("20.18.1").ok, false);
	assert.equal(checkNodeVersion("20.19.0").ok, true);
	assert.equal(checkNodeVersion("22.11.0").ok, false);
	assert.equal(checkNodeVersion("22.12.0").ok, true);
	assert.equal(checkNodeVersion("24.3.0").ok, true);
	assert.equal(checkNodeVersion("18.20.4").ok, false);
});

function fakeProject() {
	const root = mkdtempSync(join(tmpdir(), "mp-launch-"));
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	mkdirSync(join(root, "public"));
	writeFileSync(join(root, "src", "deep", "a.ts"), "export {}");
	writeFileSync(join(root, "public", "logo.svg"), "<svg/>");
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
	return root;
}

test("a build is needed until it is marked, and again after a source change", () => {
	const root = fakeProject();
	try {
		assert.equal(needsBuild(root), true);
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist", "index.html"), "<html>");
		markBuilt(root);
		assert.equal(needsBuild(root), false);
		const later = new Date(Date.now() + 5000);
		utimesSync(join(root, "src", "deep", "a.ts"), later, later);
		assert.equal(needsBuild(root), true);
		markBuilt(root);
		writeFileSync(join(root, "src", "deep", "b.ts"), "export {}");
		assert.equal(needsBuild(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dependencies are installed when missing or when the lockfile changed", () => {
	const root = fakeProject();
	try {
		assert.equal(needsInstall(root), true);
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules", ".modules.yaml"), "x");
		const past = new Date(Date.now() - 60000);
		utimesSync(join(root, "pnpm-lock.yaml"), past, past);
		assert.equal(needsInstall(root), false);
		const later = new Date(Date.now() + 60000);
		utimesSync(join(root, "pnpm-lock.yaml"), later, later);
		assert.equal(needsInstall(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pnpm is found directly, then through corepack, then through npx", () => {
	const works = (ok) => (cmd, args) => ({ status: ok.includes(`${cmd} ${args[0]}`) ? 0 : 1 });
	assert.deepEqual(findPnpm(works(["pnpm --version"])), ["pnpm"]);
	assert.deepEqual(findPnpm(works(["corepack pnpm"])), ["corepack", "pnpm"]);
	assert.deepEqual(findPnpm(works(["npx --yes"])), ["npx", "--yes", "pnpm@10.26.2"]);
	assert.equal(findPnpm(works([])), null);
});
