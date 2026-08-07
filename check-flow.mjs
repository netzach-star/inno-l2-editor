#!/usr/bin/env node
// 真实全流程兼容测试（设计文档 §13.2）。
//
// 「这是"复现上游"这个目标**唯一的**验收方式，格式比对替代不了它。」
//
// 它要一个**真在跑的** InnoSpark 和一个**真在跑的**插件，跑一遍：
//   归档 → 在上游看到页与图 → BM25 查得到 → 编辑 → 插件里看到编辑结果
// 并逐项断言五个副作用、乐观锁、单边存储、以及裁定四的反向断言。
//
// 跑法：
//   1. 装 bridge：node bridge/apply.mjs <inno-agent 目录> install && (cd <目录> && npm run build)
//   2. 起上游：   cd <inno-agent 目录> && node apps/inno-agent/dist/server.js --home ./runtime --port 3399
//   3. 起插件：   INNO_AGENT_DIR=<inno-agent 目录> INNO_UPSTREAM=http://localhost:3399 node server.mjs
//   4. 跑本脚本： INNO_AGENT_DIR=<inno-agent 目录> UPSTREAM=http://localhost:3399 node check-flow.mjs
//
// ⚠️ 它会**真的写**知识库，而且 l2_archive 会**真的调模型**（要 API key、要花钱、十几秒）。
// 所以它不进 `check-*.mjs` 那套无 key 核验的默认序列，要手动触发。
// 建议指向 runtime 库，不要指向真实语料库。

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const UP = (process.env.UPSTREAM ?? "http://localhost:3399").replace(/\/+$/, "");
const PLUGIN = (process.env.PLUGIN ?? "http://localhost:4321").replace(/\/+$/, "");
const AGENT_DIR = process.env.INNO_AGENT_DIR;
if (!AGENT_DIR) {
	console.error("\n  需要 INNO_AGENT_DIR 指向 inno-agent 目录\n");
	process.exit(1);
}
const L2 = join(AGENT_DIR, "runtime", "data", "l2");
const WIKI = join(L2, "wiki");

let pass = 0, fail = 0;
const failures = [];
const c = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" };

function ok(name, cond, detail) {
	if (cond) { pass++; console.log(`  ${c.g}✓${c.x} ${name}`); }
	else { fail++; failures.push(name); console.log(`  ${c.r}✗${c.x} ${name}`); if (detail) console.log(`      ${c.d}${detail}${c.x}`); }
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const readBytes = (p) => readFile(p);
const readTxt = (p) => readFile(p, "utf8").catch(() => "");
const size = (p) => stat(p).then((s) => s.size).catch(() => -1);

async function api(base, method, path, body) {
	const r = await fetch(`${base}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(300_000),
	});
	let data = null;
	try { data = await r.json(); } catch { /* 可能空体 */ }
	return { status: r.status, data };
}

console.log(`\n  真实全流程兼容测试\n  上游 ${UP}\n  插件 ${PLUGIN}\n  知识库 ${WIKI}\n`);

/* ---------------- 0. 两边都活着 ---------------- */

const health = await fetch(`${UP}/health`).then((r) => r.json()).catch(() => null);
ok("上游在跑", health?.status === "ok");
const cat = await api(PLUGIN, "GET", "/api/catalog");
ok("插件在跑", cat.status === 200);
ok("插件确实指着上游那份知识库", (cat.data?.wiki?.dir ?? "") === WIKI,
	`插件说它在编辑 ${cat.data?.wiki?.dir}`);
if (fail > 0) { console.log("\n  前置条件不满足，后面不跑了\n"); process.exit(1); }

/* ---------------- 1. 归档：五个副作用 ---------------- */

console.log("\n  ── 归档（会真的调模型，十几秒）──\n");

const stamp = Date.now().toString(36);
const TITLE = `全流程测试-${stamp}`;
const MARKER = `独特标记词${stamp}`;

const idxBefore = (await readTxt(join(WIKI, "index.md"))).split("\n").filter((l) => l.startsWith("- ")).length;
const logBefore = await size(join(WIKI, "log.md"));
const manBefore = (await readTxt(join(L2, "manifest.jsonl"))).trim().split("\n").filter(Boolean).length;

const arch = await api(UP, "POST", "/api/l2/archive", {
	title: TITLE,
	sourceType: "markdown",
	tags: ["全流程测试"],
	content: `# ${TITLE}\n\n这是一段用于端到端验证的资料。${MARKER}是它独有的词。\n\n它提到 [[实数完备性]] 以便产生一条边。\n`,
});
ok("POST /api/l2/archive 返回 200", arch.status === 200, arch.data?.error);
const srcId = arch.data?.details?.id ?? "";
const srcPage = arch.data?.details?.wikiPagePath ?? "";
ok("拿到 manifest id", /^l2src_/.test(srcId), srcId);
ok("拿到 source 页路径", srcPage.startsWith("wiki/sources/"), srcPage);

// ① manifest
const manLines = (await readTxt(join(L2, "manifest.jsonl"))).trim().split("\n").filter(Boolean);
ok("副作用① manifest 多了一条", manLines.length === manBefore + 1, `${manBefore} → ${manLines.length}`);
const entry = manLines.map((l) => JSON.parse(l)).find((e) => e.id === srcId);
ok("副作用① 这条 manifest 的 status 是 indexed", entry?.status === "indexed");

// ② index.md
const idxAfter = (await readTxt(join(WIKI, "index.md"))).split("\n").filter((l) => l.startsWith("- ")).length;
ok("副作用② index.md 条目变多了", idxAfter > idxBefore, `${idxBefore} → ${idxAfter}`);

// ③ BM25
const s1 = await api(UP, "POST", "/api/l2/search", { query: MARKER, limit: 10 });
ok("副作用③ BM25 能搜到刚归档的内容",
	(s1.data?.results ?? []).some((r) => r.path === srcPage),
	`搜到的是 ${(s1.data?.results ?? []).map((r) => r.path).join(", ")}`);

// ④ overview
ok("副作用④ overview.md 存在", (await size(join(WIKI, "analysis", "overview.md"))) > 0);

// ⑤ log.md
const logAfter = await size(join(WIKI, "log.md"));
ok("副作用⑤ log.md 变长了（归档要记账）", logAfter > logBefore, `${logBefore} → ${logAfter}`);

/* ---------------- 2. 上游能看到它 ---------------- */

console.log("\n  ── 上游侧可见性 ──\n");

const pages = await api(UP, "GET", "/api/wiki/pages");
ok("上游 /api/wiki/pages 列得出这一页", (pages.data ?? []).some((p) => p.path === srcPage));
const graph = await api(UP, "GET", "/api/wiki/graph");
ok("上游 /api/wiki/graph 的节点里有它", (graph.data?.nodes ?? []).some((n) => n.id === srcPage || n.path === srcPage),
	`图里有 ${(graph.data?.nodes ?? []).length} 个节点`);

/* ---------------- 3. 用户批准的正文真的落盘 ---------------- */

console.log("\n  ── 建概念页（用户核对过的正文）──\n");

const CONCEPT = `全流程概念-${stamp}`;
const APPROVED = `# ${CONCEPT}\n\n## 定义\n\n这一段是**用户逐条核对过**的原话，${MARKER}。\n\n## 要点\n\n- 第一条要点。\n- 第二条要点。\n`;
const made = await api(UP, "POST", "/api/l2/page/concept", {
	title: CONCEPT, type: "concept", body: APPROVED, tags: ["全流程测试"],
	sourceId: srcId, sourcePagePath: srcPage, overwrite: true,
});
ok("POST /api/l2/page/concept 返回 200", made.status === 200, made.data?.error);
const conceptPath = made.data?.path ?? "";
const conceptAbs = join(L2, conceptPath);
const onDisk = await readTxt(conceptAbs);
ok("落盘的正文就是用户批准的那一份（逐字节）",
	onDisk.slice(onDisk.indexOf("\n---\n") + 5).trimStart() === APPROVED.trimStart(),
	"落盘的和送进去的不一样——l2_archive 的再总结又回来了？");
ok("这一页登记进了 manifest",
	(await readTxt(join(L2, "manifest.jsonl"))).includes(conceptPath));
const s2 = await api(UP, "POST", "/api/l2/search", { query: MARKER, limit: 20 });
ok("这一页进了 BM25 索引", (s2.data?.results ?? []).some((r) => r.path === conceptPath));

/* ---------------- 4. 乐观锁 ---------------- */

console.log("\n  ── 乐观锁（§10.1）──\n");

const enc = encodeURIComponent(conceptPath);
const got = await api(PLUGIN, "GET", `/api/page?path=${enc}`);
ok("插件读得到这一页", got.status === 200, got.data?.error);
const rev = got.data?.revisionHash ?? "";
ok("插件返回 revisionHash", /^[0-9a-f]{64}$/.test(rev));
ok("revisionHash = 整个文件字节的 sha256", rev === sha(await readBytes(conceptAbs)));
ok("不再返回 mtimeMs（它在同步盘上不可靠）", !("mtimeMs" in (got.data ?? {})));

const noRev = await api(PLUGIN, "PUT", "/api/page", { path: conceptPath, tags: ["x"] });
ok("不带 baseRevision 被拒（这条护栏没有后门）", noRev.status === 400);

const stale = await api(PLUGIN, "PUT", "/api/page", { path: conceptPath, baseRevision: "deadbeef", tags: ["x"] });
ok("错的 baseRevision 返回 409", stale.status === 409);
ok("409 里给回了磁盘当前内容，好让用户比对", (stale.data?.content ?? "").length > 0);
ok("409 里给回了磁盘当前的 revisionHash", stale.data?.revisionHash === rev);

/* ---------------- 5. 只改标签：正文字节不变 + 裁定四反向断言 ---------------- */

console.log("\n  ── 只改标签（§10.2 + 裁定四）──\n");

const bodyBefore = (await readTxt(conceptAbs)).split("\n---\n").slice(1).join("\n---\n");
const logB = await size(join(WIKI, "log.md"));
const idxB = await readTxt(join(WIKI, "index.md"));

const tagged = await api(PLUGIN, "PUT", "/api/page", {
	path: conceptPath, baseRevision: rev, tags: ["全流程测试", "新标签"],
});
ok("只改标签保存成功", tagged.status === 200, tagged.data?.error);

const after = await readTxt(conceptAbs);
ok("只改标签 → 正文逐字节不变", after.split("\n---\n").slice(1).join("\n---\n") === bodyBefore);
ok("只改标签 → 标签真的改了", /tags: \[全流程测试, 新标签\]/.test(after));
ok("只改标签 → updated 与上游同形（不带引号）", /\nupdated: \d{4}-\d{2}-\d{2}\n/.test(after));

// 裁定四：编辑保存后 rebuildIndex 与 appendLog 都不补
ok("裁定四 · 编辑后 log.md 字节数不变（没补 appendLog）", (await size(join(WIKI, "log.md"))) === logB);
ok("裁定四 · 编辑后 index.md 逐字节不变（没补 rebuildIndex）", (await readTxt(join(WIKI, "index.md"))) === idxB);

/* ---------------- 6. 单边存储（§11 / U-K） ---------------- */

console.log("\n  ── 单边存储（§11）──\n");

const targetPath = "wiki/concepts/实数完备性.md";
const targetAbs = join(L2, targetPath);
const targetBefore = sha(await readBytes(targetAbs));
const cur = await api(PLUGIN, "GET", `/api/page?path=${enc}`);
const linked = await api(PLUGIN, "PUT", "/api/page", {
	path: conceptPath,
	baseRevision: cur.data.revisionHash,
	body: cur.data.body,
	links: ["实数完备性"],
});
ok("在 A 页加一条关联，保存成功", linked.status === 200, linked.data?.error);
ok("§11 · B 页字节完全不变（没有对端写入）", sha(await readBytes(targetAbs)) === targetBefore);
ok("§11 · 响应里没有 reverseSynced（对端写入已拆掉）", !("reverseSynced" in (linked.data ?? {})));
ok("A 页确实写上了这条关联", (await readTxt(conceptAbs)).includes("[[实数完备性]]"));

/* ---------------- 7. 反向链接查询得出（U-F①） ---------------- */

console.log("\n  ── 反向链接（U-F①）──\n");

const bPage = await api(PLUGIN, "GET", `/api/page?path=${encodeURIComponent(targetPath)}`);
const backs = (bPage.data?.backlinks ?? []).map((b) => b.path);
ok("打开 B 页能看到「被 A 引用」", backs.includes(conceptPath), `实际入链：${backs.join(", ") || "（空）"}`);
ok("反向链接是算出来的，不在 B 的正文里", !(await readTxt(targetAbs)).includes(CONCEPT));

/* ---------------- 8. 上游没在跑时如实报错 ---------------- */

console.log("\n  ── 上游不可用时的诚实性（红线 3）──\n");

const bad = await fetch(`${PLUGIN}/api/page`, {
	method: "PUT",
	headers: { "content-type": "application/json" },
	// 指向一个必然连不上的端口，看插件是不是老实说"保存不可用"
}).catch(() => null);
void bad;
console.log(`  ${c.d}（此项需要单独起一个 INNO_UPSTREAM 指向死端口的插件实例，见 README）${c.x}`);

/* ---------------- 结果 ---------------- */

console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) {
	console.log("  失败项：");
	for (const f of failures) console.log(`    · ${f}`);
	console.log("");
	process.exit(1);
}
console.log(`  ${c.d}本次测试在知识库里留下了：${TITLE} / ${CONCEPT}${c.x}\n`);
