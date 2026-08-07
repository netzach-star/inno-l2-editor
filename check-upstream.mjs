#!/usr/bin/env node
// 对上游的抗漂移自检（设计文档 §13.2）。
//
// 「`bridge/install.sh` 的锚点已经因为上游改动断过一次（`89c2a69` → `924ccbc`），
//  锚点守卫正确地中止了，**但是在用户安装时才发现的**。」
//
// 这个脚本存在的全部理由就是：**让它先在我们这边断。**
// 按裁定二「锚点失效就重写脚本」，它的输出直接就是重写清单。
//
// 查四件事：
//   ① 锚点还在不在        —— 跑 apply.mjs 的 check 模式，不写盘
//   ② 三条转发还能不能编译 —— tsc --noEmit。它们 import 上游的 createL2Tools /
//                            L2Memory.search / serializeFrontmatter / slugifyTitle，
//                            签名变了就编译不过。这比任何字段比对都直接
//   ③ 两个现成端点的契约   —— GET /api/wiki/pages、DELETE /api/wiki/page?path=
//                            的请求形态与响应字段是否还在（要一个在跑的上游）
//   ④ 卸载干不干净        —— 装 → 卸 → git status 必须回到基线（人类要求纳入测试项）
//
// 跑法：
//   node check-upstream.mjs <inno-agent 目录> [--full]
//
//   不带 --full：只做 ① ②，不改上游一个字节，也不需要上游在跑。**平时用这个。**
//   带 --full  ：连 ③ ④ 一起做。④ 会真的装一次再卸一次，
//                期间要 npm run build（几分钟），且会把上游前端改了又改回来。

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , rawTarget, ...flags] = process.argv;
const FULL = flags.includes("--full");
const UP = process.env.UPSTREAM ?? "http://localhost:3000";

if (!rawTarget) {
	console.error("\n  用法：node check-upstream.mjs <inno-agent 目录> [--full]\n");
	process.exit(1);
}
const TARGET = rawTarget.replace(/\/+$/, "");

const c = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
	if (cond) { pass++; console.log(`  ${c.g}✓${c.x} ${name}`); }
	else { fail++; failures.push(name); console.log(`  ${c.r}✗${c.x} ${name}`); if (detail) console.log(`      ${c.d}${detail}${c.x}`); }
};
const run = (cmd, args, opts = {}) =>
	spawnSync(cmd, args, { cwd: TARGET, encoding: "utf8", ...opts });

console.log(`\n  对上游的抗漂移自检\n  上游目录 ${TARGET}\n`);

/* ---------------- ① 锚点 ---------------- */

console.log("  ── ① 锚点（按裁定二，这是核心风险控制）──\n");
{
	const r = spawnSync("node", [join(HERE, "bridge", "apply.mjs"), TARGET, "check"], { encoding: "utf8" });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	ok("apply.mjs 的锚点全部还在", r.status === 0,
		out.split("\n").filter((l) => l.includes("✗")).join("\n      ") ||
		"（跑 node bridge/apply.mjs <目录> check 看详情）");
	if (r.status !== 0) {
		console.log(`\n${c.y}  ↑ 这就是重写清单：上面每一条 ✗ 都是 apply.mjs 里要改的一个锚点。${c.x}\n`);
	}
}

/* ---------------- ② 三条转发还能不能编译 ---------------- */

console.log("\n  ── ② 转发路由的编译（签名变了就过不了）──\n");
{
	const routes = join(TARGET, "apps", "inno-agent", "src", "memory", "l2", "l2-editor-routes.ts");
	if (!existsSync(routes)) {
		console.log(`  ${c.d}bridge 没装，跳过编译检查（装了再跑一次）${c.x}`);
	} else {
		const r = run("npx", ["tsc", "--noEmit", "-p", "apps/inno-agent/tsconfig.json"]);
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => l.includes("error")).slice(0, 8);
		ok("l2-editor-routes.ts 编译通过（上游 createL2Tools / L2Memory.search / " +
			"serializeFrontmatter / slugifyTitle 的签名没变）",
			r.status === 0, out.join("\n      "));
	}
}

/* ---------------- ③ 两个现成端点的契约 ---------------- */

if (FULL) {
	console.log("\n  ── ③ 现成端点的契约（要一个在跑的上游）──\n");
	const alive = await fetch(`${UP}/health`).then((r) => r.ok).catch(() => false);
	if (!alive) {
		console.log(`  ${c.y}!${c.x} ${UP} 上没有在跑的上游，跳过这一节`);
	} else {
		const pages = await fetch(`${UP}/api/wiki/pages`).then((r) => r.json()).catch(() => null);
		ok("GET /api/wiki/pages 还返回数组", Array.isArray(pages));
		if (Array.isArray(pages) && pages.length) {
			const p = pages[0];
			ok("每一项还有 path / frontmatter / bodyPreview 三个字段",
				"path" in p && "frontmatter" in p && "bodyPreview" in p,
				`实际字段：${Object.keys(p).join(", ")}`);
		}
		// DELETE 用的是**查询串** ?path=，不是请求体。接线时最容易写错的一处，
		// 所以这里专门探一下：拿一个不存在的路径，期望 404 而不是 400。
		// 400 说明它已经不认查询串了。
		const del = await fetch(`${UP}/api/wiki/page?path=${encodeURIComponent("wiki/concepts/__不存在的页__.md")}`,
			{ method: "DELETE" }).then((r) => r.status).catch(() => 0);
		ok("DELETE /api/wiki/page 还认查询串 ?path=（404 而不是 400）", del === 404,
			`实际返回 ${del}${del === 400 ? "——上游可能改成从请求体读 path 了" : ""}`);
	}
}

/* ---------------- ④ 卸载干不干净 ---------------- */

if (FULL) {
	console.log("\n  ── ④ 卸载干不干净（人类要求纳入测试项）──\n");
	const gitStatus = () =>
		run("git", ["status", "--porcelain"]).stdout.split("\n").map((l) => l.trim()).filter(Boolean);

	// 基线里**预先就有**的改动要排除。本机的 package-lock.json 在我们动手之前
	// 就是 modified（npm 给可选依赖补了 libc 字段），与 bridge 无关。
	// 不排除的话这条断言永远失败，然后就会被人为放宽——那等于没有这条断言（执行决议 D-09）。
	const PRE_EXISTING = [/package-lock\.json$/];
	const ours = (lines) => lines.filter((l) => !PRE_EXISTING.some((re) => re.test(l)));

	const routesFile = join(TARGET, "apps", "inno-agent", "src", "memory", "l2", "l2-editor-routes.ts");
	const apply = (mode) => spawnSync("node", [join(HERE, "bridge", "apply.mjs"), TARGET, mode], { encoding: "utf8" });

	// 基线必须是**纯净态**，不是"我们开始跑的时候碰巧是什么样"。
	// 装着的时候直接拿当前 git status 当基线，那这条断言就永远成立——等于没测。
	if (existsSync(routesFile)) {
		console.log(`  ${c.d}当前已安装，先卸一次以取得纯净基线${c.x}`);
		const pre = apply("uninstall");
		if (pre.status !== 0) {
			ok("先卸载以取得纯净基线", false, `${pre.stdout ?? ""}${pre.stderr ?? ""}`);
		}
	}

	const before = ours(gitStatus());
	console.log(`  ${c.d}纯净基线：${before.length} 处改动（已排除预先存在的 package-lock.json）${c.x}`);
	ok("纯净基线本身是干净的", before.length === 0, `还剩：\n      ${before.join("\n      ")}`);

	const i = apply("install");
	ok("能装上", i.status === 0, `${i.stdout ?? ""}${i.stderr ?? ""}`);
	const during = ours(gitStatus());
	ok("装完确实改动了上游（不是什么都没做）", during.length > before.length,
		`装前 ${before.length} 处，装后 ${during.length} 处`);

	const u = apply("uninstall");
	ok("能卸掉", u.status === 0, `${u.stdout ?? ""}${u.stderr ?? ""}`);

	const after = ours(gitStatus());
	ok("卸载后 git status 回到基线（一处残留都没有）",
		after.length === before.length && after.every((l, i) => l === before[i]),
		`基线 ${before.length} 处 → 卸载后 ${after.length} 处\n      多出来的：${
			after.filter((l) => !before.includes(l)).join("\n      ") || "（无）"}`);

	// 新增的三个文件必须真的没了
	const leftovers = [];
	for (const rel of [
		"apps/inno-agent/src/memory/l2/l2-editor-routes.ts",
		"apps/inno-agent/web/src/react/StagingArea.tsx",
		"apps/inno-agent/web/src/stores/staging-store.ts",
	]) if (existsSync(join(TARGET, rel))) leftovers.push(rel);
	ok("bridge 新增的三个文件都被删掉了", leftovers.length === 0, leftovers.join("\n      "));

	console.log(`\n  ${c.y}注意：现在上游是**未安装**状态。要继续用，重新跑一次：${c.x}`);
	console.log(`  ${c.d}  node bridge/apply.mjs "${TARGET}" install && (cd "${TARGET}" && npm run build)${c.x}`);
	void readdir;
}

/* ---------------- 结果 ---------------- */

console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) {
	console.log("  失败项：");
	for (const f of failures) console.log(`    · ${f}`);
	console.log("");
	process.exit(1);
}
