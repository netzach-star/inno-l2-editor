// 端到端核验 S-C 的写盘边界。跑法：先 node server.mjs，再 node check-pipeline.mjs
// 不需要 API key——只测摄入、冻结对账、引文校验、落盘拒绝，都不经过模型。
//
// 这个文件存在的理由：`/api/compile` 查了冻结、`/api/page/create` 一开始忘了查，
// 导致改一改 raw.md 就能让编造的句子写进知识库。修完必须有断言钉住。

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
const cleanup = async (...ids) => {
	for (const t of TITLES) await rm(pagePath(t), { force: true });
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

	const inSeg = await post("/api/page/create", {
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
	const good = await post("/api/page/create", {
		sourceId, title: TITLES[0], summary: "一句话说明。", tags: ["测试"], links: [],
		facts: [{ text: "拉格朗日中值定理是罗尔定理的推广", quote: "拉格朗日中值定理是罗尔定理的推广" }],
	});
	ok("照抄原文的内容写入成功", good.status === 200 && good.body.ok === true);
	ok("页面确实出现在磁盘上", await exists(pagePath(TITLES[0])));
	const written = await readFile(pagePath(TITLES[0]), "utf8");
	ok("frontmatter 带上了 source_ids", written.includes(`- ${sourceId}`));
	ok("frontmatter 与上游 SCHEMA 同构",
		["title:", "created:", "type: concept", "tags:", "sources:", "source_ids:", "updated:", "status:", "confidence:"]
			.every((k) => written.includes(k)));

	const dup = await post("/api/page/create", {
		sourceId, title: TITLES[0], summary: "x", tags: [], links: [],
		facts: [{ text: "拉格朗日中值定理是罗尔定理的推广", quote: "拉格朗日中值定理是罗尔定理的推广" }],
	});
	ok("同名页面不会被覆盖", dup.status === 409 && dup.body.reason === "exists");
} finally {
	await cleanup(sourceId, multiId);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
