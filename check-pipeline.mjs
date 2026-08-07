// 端到端核验写盘边界。跑法：先 node server.mjs，再 node check-pipeline.mjs
//
// 这个文件存在的理由：`/api/compile` 查了冻结、`/api/page/create` 一开始忘了查，
// 导致改一改 raw.md 就能让编造的句子写进知识库。修完必须有断言钉住。
//
// ── v2.0 起它需要一个真在跑的 InnoSpark ──
// 建页不再由插件自己写盘，而是转发给上游（§4）：
//   ① POST /api/l2/archive        归档冻结来源（**要调模型**）
//   ② POST /api/l2/page/concept   写用户批准的正文
// 而且转成了后台任务，`/api/page/create` 返回 202 + taskId，要轮询 `/api/task`。
//
// 所以**被拒绝的那些用例仍然不花钱**（校验在插件侧、写盘之前就拦住了，
// 根本走不到上游），只有"应当写成功"的那两三条会真的调模型。
// 拒绝路径才是这个文件的重点，它们不需要 key 也跑得动。

import { readFile, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const B = process.env.BASE ?? "http://localhost:4321";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
	else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};
const post = async (path, body) => {
	const r = await fetch(B + path, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: r.status, body: await r.json() };
};
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/**
 * 发起建页并等它跑完。
 *
 * v2.0 起建页是后台任务（§4「不能用『保存中…』的模态框把人糊住」），
 * 所以成功路径返回的是 202 + taskId，要轮询。
 * 被拒绝的路径（引文定位不过、来源被篡改）仍然是同步的 4xx——
 * 那些校验在插件侧、写盘之前就做完了，压根走不到上游，也就不花钱。
 */
const createAndWait = async (body, timeoutMs = 240_000) => {
	const started = await post("/api/page/create", body);
	if (started.status !== 202) return started;   // 同步拒绝，原样返回
	const id = started.body.taskId;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1000));
		const t = await (await fetch(`${B}/api/task?id=${encodeURIComponent(id)}`)).json();
		if (t.state === "done") return { status: 200, body: { ok: true, ...t.result } };
		if (t.state === "failed") return { status: 502, body: { ok: false, error: t.error, reason: t.reason } };
	}
	return { status: 504, body: { ok: false, error: "后台任务超时" } };
};

const SOURCE_TEXT = [
	"# 中值定理测试语料",
	"",
	"罗尔定理要求函数在闭区间连续、开区间可导，且两端点函数值相等。",
	"拉格朗日中值定理是罗尔定理的推广，去掉了端点值相等的要求。",
].join("\n");

const TITLES = ["流水线测试-合法页", "流水线测试-编造页", "流水线测试-混合页", "流水线测试-篡改页",
                "流水线测试-多段页", "流水线测试-多段编造页"];

console.log("\nS-C 写盘边界核验\n");

// wiki 目录不能写死成 ./data/wiki——接上 InnoSpark 时它在别处。问服务端要
let WIKI_DIR;
let SOURCES_DIR;
try {
	const cat = await (await fetch(B + "/api/catalog")).json();
	WIKI_DIR = cat.wiki?.dir ?? join(ROOT, "data", "wiki");
	SOURCES_DIR = process.env.INNO_SOURCES_DIR ?? join(ROOT, "data", "sources");
	console.log(`  知识库：${WIKI_DIR}${cat.wiki?.live ? "" : "（沙盒样例）"}\n`);
} catch {
	console.log(`  ✗ 连不上 ${B}，先跑 node server.mjs\n`);
	process.exit(1);
}

const pagePath = (t) => join(WIKI_DIR, "concepts", `${t}.md`);

// 收尾：把本次测试造出来的东西清掉
// 收尾走**上游的删除端点**，不要直接 rm ——直接删会把 manifest 与检索索引留脏，
// 那正是 §4 说的"绕过维护逻辑"。测试自己也得守这条规矩。
const cleanup = async (...ids) => {
	for (const t of TITLES) {
		if (!(await exists(pagePath(t)))) continue;
		await fetch(`${B}/api/page?path=${encodeURIComponent(`wiki/concepts/${t}.md`)}`, { method: "DELETE" })
			.catch(() => rm(pagePath(t), { force: true }));
	}
	for (const id of ids) {
		if (id) await rm(join(SOURCES_DIR, id), { recursive: true, force: true });
	}
};

let sourceId = null;
let multiId = null;
try {
	await cleanup();

	console.log("一、摄入与冻结");
	const ing = await post("/api/sources", { filename: "流水线测试语料.md", text: SOURCE_TEXT });
	ok("摄入成功", ing.status === 200 && ing.body.ok === true);
	sourceId = ing.body.source?.sourceId;
	ok("拿到内容寻址的 sourceId", typeof sourceId === "string" && sourceId.startsWith("src_"), `→ ${sourceId}`);
	ok("首次摄入不是 alreadyFrozen", ing.body.alreadyFrozen === false);

	const again = await post("/api/sources", { filename: "换个名字.md", text: SOURCE_TEXT });
	ok("同内容重复摄入幂等", again.body.source.sourceId === sourceId && again.body.alreadyFrozen === true);

	const list = await (await fetch(B + "/api/sources")).json();
	ok("列表里这份来源 intact", list.sources.find((s) => s.sourceId === sourceId)?.intact === true);

	console.log("\n一之二、多段摄入（把 AI 的几轮回答攒成一份资料）");
	const multi = await post("/api/sources", {
		title: "多段测试资料",
		segments: ["第一段：罗尔定理要求两端点函数值相等。", "第二段：拉格朗日是罗尔的推广。"],
	});
	multiId = multi.body.source?.sourceId;
	ok("多段摄入成功", multi.status === 200 && multi.body.ok === true);
	ok("记录了段数", multi.body.source?.segments === 2);
	ok("多段同样是内容寻址", typeof multiId === "string" && multiId.startsWith("src_"));

	const multiSame = await post("/api/sources", {
		title: "换个名",
		segments: ["第一段：罗尔定理要求两端点函数值相等。", "第二段：拉格朗日是罗尔的推广。"],
	});
	ok("同样几段重复摄入幂等", multiSame.body.source?.sourceId === multiId);

	const inSeg = await createAndWait({
		sourceId: multiId, title: TITLES[4], summary: "x", tags: [], links: [],
		facts: [{ text: "拉格朗日是罗尔的推广", quote: "第二段：拉格朗日是罗尔的推广。" }],
	});
	ok("段内照抄的引文通过", inSeg.status === 200 && inSeg.body.ok === true);

	const fakeSeg = await post("/api/page/create", {
		sourceId: multiId, title: TITLES[5], summary: "x", tags: [], links: [],
		facts: [{ text: "编的", quote: "第三段：柯西中值定理" }],
	});
	ok("多段来源里编造的引文照样被拒", fakeSeg.status === 422);

	const spanning = await post("/api/page/create", {
		sourceId: multiId, title: TITLES[5], summary: "x", tags: [], links: [],
		facts: [{ text: "跨段拼接", quote: "两端点函数值相等。第二段：拉格朗日" }],
	});
	ok("跨段拼接（跳过了分隔线）被拒", spanning.status === 422);

	const emptySeg = await post("/api/sources", { title: "空的", segments: ["  ", ""] });
	ok("全空的段被拒", emptySeg.status === 400);

	console.log("\n二、写盘边界拦不拦得住编造（客户端可以撒谎，服务端不能信）");
	const fabricated = await post("/api/page/create", {
		sourceId, title: TITLES[1], summary: "x", tags: [], links: [],
		facts: [{ text: "罗尔定理由柯西在1823年提出", quote: "罗尔定理由柯西在1823年提出" }],
	});
	ok("纯编造的引文被拒", fabricated.status === 422 && fabricated.body.reason === "citation_failed");
	ok("编造的页面没有落盘", !(await exists(pagePath(TITLES[1]))));

	const mixed = await post("/api/page/create", {
		sourceId, title: TITLES[2], summary: "x", tags: [], links: [],
		facts: [
			{ text: "真的", quote: "拉格朗日中值定理是罗尔定理的推广" },
			{ text: "假的", quote: "这句话原文里根本没有" },
		],
	});
	ok("一真一假整体被拒（不是只写真的那条）", mixed.status === 422);
	ok("混合页没有落盘", !(await exists(pagePath(TITLES[2]))));

	console.log("\n三、冻结对账必须在引文校验之前");
	const rawFile = join(SOURCES_DIR, sourceId, "raw.md");
	const original = await readFile(rawFile, "utf8");
	await writeFile(rawFile, original + "\n偷偷加的一句话。", "utf8");

	const listAfter = await (await fetch(B + "/api/sources")).json();
	ok("篡改后列表显示 intact=false",
		listAfter.sources.find((s) => s.sourceId === sourceId)?.intact === false);

	const compiled = await post("/api/compile", { sourceId });
	ok("篡改后拒绝编译", compiled.status === 409 && compiled.body.reason === "source_tampered");

	// 关键回归：引文在**被篡改的**文本里确实找得到，所以只做子串校验会放行
	const tampered = await post("/api/page/create", {
		sourceId, title: TITLES[3], summary: "x", tags: [], links: [],
		facts: [{ text: "偷加的", quote: "偷偷加的一句话" }],
	});
	ok("篡改后拒绝写入（回归：这里曾经漏过）",
		tampered.status === 409 && tampered.body.reason === "source_tampered");
	ok("篡改页没有落盘", !(await exists(pagePath(TITLES[3]))));

	await writeFile(rawFile, original, "utf8");
	ok("还原后重新 intact",
		(await (await fetch(B + "/api/sources")).json())
			.sources.find((s) => s.sourceId === sourceId)?.intact === true);

	console.log("\n四、合法内容能正常落盘");
	const good = await createAndWait({
		sourceId, title: TITLES[0], summary: "一句话说明。", tags: ["测试"], links: [],
		facts: [{ text: "拉格朗日中值定理是罗尔定理的推广", quote: "拉格朗日中值定理是罗尔定理的推广" }],
	});
	ok("照抄原文的内容写入成功", good.status === 200 && good.body.ok === true);
	ok("页面确实出现在磁盘上", await exists(pagePath(TITLES[0])));
	const written = await readFile(pagePath(TITLES[0]), "utf8");
	// v2.0：页面 frontmatter 里的 source_ids 是**上游**的 l2src_，不是插件的 src_。
	// 两个 ID 空间的映射存在插件侧的 meta.json 里，不往上游数据结构里塞字段（§4）。
	ok("frontmatter 的 source_ids 是上游的 l2src_", /source_ids:\s*\n\s*- l2src_/.test(written));
	{
		const meta = JSON.parse(await readFile(join(SOURCES_DIR, "meta.json"), "utf8").catch(() => "{}"));
		ok("插件侧记下了 src_ ↔ l2src_ 的映射",
			/^l2src_/.test(meta[sourceId]?.upstreamId ?? ""),
			`meta[${sourceId}] = ${JSON.stringify(meta[sourceId] ?? null)}`);
	}
	ok("落盘的正文就是用户批准的那一份（不是 l2_archive 又总结一遍的版本）",
		written.includes("拉格朗日中值定理是罗尔定理的推广"));
	ok("frontmatter 与上游 SCHEMA 同构",
		["title:", "created:", "type: concept", "tags:", "sources:", "source_ids:", "updated:", "status:", "confidence:"]
			.every((k) => written.includes(k)));

	// ── 同名页的行为在 v2.0 变了，这条断言跟着反过来 ──
	// 旧行为：409「已经有一页叫这个了」。
	// 新行为：**用用户批准的版本覆盖**（人类裁定 2026-08-07）。
	// 理由是实测发现 l2_archive 的 maintainLinkedWikiPages 十有八九**自己就建了同名页**，
	// 于是"建用户批准的那一页"必然撞名——再报 409 就等于这条链路根本走不通。
	// 覆盖的只是正文；created / status / confidence 等页面自身历史保留，
	// tags / sources / source_ids 做并集（见 l2-editor-routes.ts）。
	const dup = await createAndWait({
		sourceId, title: TITLES[0], summary: "第二次写入的说明。", tags: ["第二次"], links: [],
		facts: [{ text: "罗尔定理要求两端点函数值相等", quote: "且两端点函数值相等" }],
	});
	ok("同名页被用户批准的新版本覆盖（不再报 409）", dup.status === 200 && dup.body.ok === true);
	{
		const again = await readFile(pagePath(TITLES[0]), "utf8");
		ok("覆盖后正文是第二次的内容", again.includes("罗尔定理要求两端点函数值相等"));
		ok("覆盖保留了页面原有的 created", /created: \d{4}-\d{2}-\d{2}/.test(again));
		ok("覆盖把标签做了并集，没抹掉第一次的", again.includes("测试") && again.includes("第二次"));
	}
} finally {
	await cleanup(sourceId, multiId);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
