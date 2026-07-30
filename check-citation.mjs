// 引文校验与来源冻结的证据。跑法：node check-citation.mjs
// 不需要 API key——校验发生在模型返回之后，跟模型没关系。

import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFacts, normalizeForQuoteMatch, checkQuote } from "./citation.mjs";
import { ingestSource, listSources, readSource, verifySource, sourceIdFor } from "./source-store.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); }
	else { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

const SRC = [
	"# 微分中值定理",
	"",
	"罗尔定理要求函数在闭区间连续、开区间可导，且两端点函数值相等。",
	"拉格朗日中值定理是罗尔定理的推广，去掉了端点值相等的要求。",
	"柯西中值定理进一步把它推广到两个函数的情形。",
].join("\n");

console.log("\n引文校验与来源冻结核验（S-C 最小版）\n");

console.log("一、引文必须是冻结来源的精确子串（红线 2）");
{
	const r = validateFacts([
		{ text: "罗尔定理需要端点值相等", quote: "且两端点函数值相等" },
		{ text: "拉格朗日是罗尔的推广", quote: "拉格朗日中值定理是罗尔定理的推广" },
	], SRC);
	ok("照抄原文的引文通过", r.every((f) => f.verified));
}
{
	const r = validateFacts([
		{ text: "罗尔定理由柯西在1823年提出", quote: "罗尔定理由柯西在1823年提出" },
	], SRC);
	ok("编造的引文被拦下", !r[0].verified && r[0].problem.code === "QUOTE_NOT_IN_SOURCE");
}
{
	// 最危险的一类：话说得对，但引文是改写的而不是照抄的
	const r = validateFacts([
		{ text: "拉格朗日是罗尔的推广", quote: "拉格朗日中值定理乃罗尔定理之推广" },
	], SRC);
	ok("改写过（而非照抄）的引文被拦下", !r[0].verified);
}
{
	const r = validateFacts([
		{ text: "有这么回事", quote: "" },
		{ text: "", quote: "罗尔定理" },
	], SRC);
	ok("没有引文的被拦下", !r[0].verified && r[0].problem.code === "MISSING_QUOTE");
	ok("空事实被拦下", !r[1].verified && r[1].problem.code === "EMPTY_FACT");
}
{
	const r = validateFacts([{ text: "长", quote: "罗".repeat(501) }], SRC);
	ok("超长引文被拦下", !r[0].verified && r[0].problem.code === "QUOTE_TOO_LONG");
}
{
	// 拼接：两段都在原文里，但连起来不在
	const r = validateFacts([
		{ text: "拼的", quote: "罗尔定理要求函数在闭区间连续柯西中值定理进一步" },
	], SRC);
	ok("把两处原文拼起来的引文被拦下", !r[0].verified);
}

console.log("\n二、规范化不制造假阴性（合法引用不该被误杀）");
{
	const pdfish = "拉格朗日中值定\n理是罗尔定理的推广";   // PDF 断行
	ok("跨行的引文仍能匹配", checkQuote(pdfish, normalizeForQuoteMatch(SRC)) === null);
}
{
	const hyphenated = "闭区间连-\n续";
	const src = "函数在闭区间连续、开区间可导";
	ok("PDF 行尾断字连字符被还原", checkQuote(hyphenated, normalizeForQuoteMatch(src)) === null);
}
{
	ok("中文里多余空格不影响匹配",
		checkQuote("拉格朗日中值定理   是罗尔定理的推广", normalizeForQuoteMatch(SRC)) === null);
}
{
	// 跨自然段但在原文里连续的引文，应当通过
	ok("跨换行但原文连续的引文通过",
		checkQuote("且两端点函数值相等。拉格朗日中值定理是罗尔定理的推广", normalizeForQuoteMatch(SRC)) === null);
}
{
	// 英文仍按上游口径：空格是词边界，不能删
	const en = "the mean value theorem";
	ok("英文词间空格不被删除（不制造假阳性）",
		checkQuote("themeanvalue", normalizeForQuoteMatch(en))?.code === "QUOTE_NOT_IN_SOURCE");
	ok("英文跨行仍折叠为空格后匹配",
		checkQuote("the mean\nvalue theorem", normalizeForQuoteMatch(en)) === null);
}
{
	// 刻意不做大小写折叠——大小写是有意义的事实差异
	const src = "The Mean Value Theorem states that";
	ok("大小写不同视为不同（不做折叠）",
		checkQuote("the mean value theorem", normalizeForQuoteMatch(src))?.code === "QUOTE_NOT_IN_SOURCE");
}

console.log("\n三、来源冻结是可核验的，不是一句承诺");
const dir = await mkdtemp(join(tmpdir(), "inno-src-"));
try {
	const { meta, alreadyFrozen } = await ingestSource(dir, { filename: "数学分析.md", text: SRC });
	ok("摄入后拿到内容寻址的 sourceId", meta.sourceId.startsWith("src_"), `→ ${meta.sourceId}`);
	ok("首次摄入不是 alreadyFrozen", alreadyFrozen === false);

	const again = await ingestSource(dir, { filename: "改了个名.md", text: SRC });
	ok("同内容重复摄入是幂等的", again.meta.sourceId === meta.sourceId && again.alreadyFrozen === true);
	ok("重复摄入不覆写原有 meta", again.meta.filename === "数学分析.md");

	const other = await ingestSource(dir, { filename: "别的.md", text: SRC + "\n多了一行" });
	ok("内容不同则 sourceId 不同", other.meta.sourceId !== meta.sourceId);

	ok("列表能列出两份来源", (await listSources(dir)).length === 2);

	const v1 = await verifySource(dir, meta.sourceId);
	ok("未被篡改时对账通过", v1.intact === true);

	// 把冻结的原件改掉，对账必须立刻失败
	await writeFile(join(dir, meta.sourceId, "raw.md"), SRC + "\n偷偷加的一句", "utf8");
	const v2 = await verifySource(dir, meta.sourceId);
	ok("原件被改动后对账失败", v2.intact === false);

	// 篡改后，原本合法的引文仍然「能匹配」——但这正是为什么要有对账：
	// 引文校验只保证「和文件一致」，冻结校验才保证「文件和摄入时一致」
	const tampered = await readSource(dir, meta.sourceId);
	const r = validateFacts([{ text: "偷加的", quote: "偷偷加的一句" }], tampered.text);
	ok("篡改后的内容能骗过引文校验（所以必须先查冻结）", r[0].verified === true);
	ok("但冻结对账拦得住它", (await verifySource(dir, meta.sourceId)).intact === false);

	ok("sourceIdFor 对同一内容稳定", sourceIdFor(SRC).sourceId === sourceIdFor(SRC).sourceId);
	void readFile;
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
