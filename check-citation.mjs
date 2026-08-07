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

console.log("\n引文定位与来源冻结核验（U-A/A1）\n");

console.log("一、引文必须能在冻结来源里定位到（红线 2）");
{
	const r = validateFacts([
		{ text: "罗尔定理需要端点值相等", quote: "且两端点函数值相等" },
		{ text: "拉格朗日是罗尔的推广", quote: "拉格朗日中值定理是罗尔定理的推广" },
	], SRC);
	ok("照抄原文的引文能定位到", r.every((f) => f.anchor === "exact"));
}
{
	const r = validateFacts([
		{ text: "罗尔定理由柯西在1823年提出", quote: "罗尔定理由柯西在1823年提出" },
	], SRC);
	ok("编造的引文被拦下（§1 要求这条必须仍然通过）", r[0].anchor === "none" && r[0].problem.code === "QUOTE_NOT_IN_SOURCE");
}
{
	// 最危险的一类：话说得对，但引文是改写的而不是照抄的
	const r = validateFacts([
		{ text: "拉格朗日是罗尔的推广", quote: "拉格朗日中值定理乃罗尔定理之推广" },
	], SRC);
	// §1 说这条在 A2（模糊重锚）落地后应改判为 fuzzy 并附真原文。
	// 但 A2 按 0.6 后移，本批次只做第 0 层（剥记号），它是精确的、不救改写。
	// 所以现在**仍然拦下**，等 A2 时再连同断言一起改。
	ok("改写过（而非照抄）的引文被拦下 —— A2 落地后此条改判 fuzzy", r[0].anchor === "none");
}
{
	const r = validateFacts([
		{ text: "有这么回事", quote: "" },
		{ text: "", quote: "罗尔定理" },
	], SRC);
	ok("没有引文的被拦下", r[0].anchor === "none" && r[0].problem.code === "MISSING_QUOTE");
	ok("空要点被拦下", r[1].anchor === "none" && r[1].problem.code === "EMPTY_FACT");
}
{
	const r = validateFacts([{ text: "长", quote: "罗".repeat(501) }], SRC);
	ok("超长引文被拦下", r[0].anchor === "none" && r[0].problem.code === "QUOTE_TOO_LONG");
}
{
	// 拼接：两段都在原文里，但连起来不在
	const r = validateFacts([
		{ text: "拼的", quote: "罗尔定理要求函数在闭区间连续柯西中值定理进一步" },
	], SRC);
	ok("把两处原文拼起来的引文被拦下（§1 要求这条必须仍然通过）", r[0].anchor === "none");
}

console.log("\n一之二、第 0 层：剥 Markdown 记号（U-A/A1）");
{
	// 原文里带记号、模型抄成纯文本——这是 §1 表里的第一类**误杀**，必须救回来
	const marked = "罗尔定理要求函数在闭区间连续，**且两端点函数值相等**，"
		+ "而 [[拉格朗日中值定理]] 是它的推广，参见 `mean value theorem`。";
	const norm = normalizeForQuoteMatch(marked);
	ok("原文带 ** 记号、引文抄成纯文本，仍能定位到",
		checkQuote("且两端点函数值相等", norm) === null);
	ok("原文带 [[ ]]、引文抄成纯文本，仍能定位到",
		checkQuote("拉格朗日中值定理", norm) === null);
	ok("原文带反引号、引文抄成纯文本，仍能定位到",
		checkQuote("mean value theorem", norm) === null);
	ok("反过来也行：引文带记号、原文是纯文本",
		checkQuote("**且两端点函数值相等**", normalizeForQuoteMatch("……且两端点函数值相等……")) === null);
	// 关键：剥记号只删记号字符，从不删实体文字，所以该拦的照样拦得住
	ok("剥了记号之后，编造的仍然拦得住",
		checkQuote("罗尔定理由柯西在1823年提出", norm) !== null);
	ok("剥了记号之后，拼接的仍然拦得住",
		checkQuote("罗尔定理要求函数在闭区间连续是它的推广", norm) !== null);
	ok("[[目标|显示]] 取前半段，与 normalizeWikiLink 同口径",
		normalizeForQuoteMatch("见 [[实数完备性|完备性]] 一节").includes("实数完备性"));
}

console.log("\n一之三、字段名与能力一致（红线 3）");
{
	const r = validateFacts([{ text: "x", quote: "且两端点函数值相等" }], SRC);
	ok("字段叫 anchor，不叫 verified", "anchor" in r[0] && !("verified" in r[0]));
	ok("取值是 exact / none 之一", ["exact", "none"].includes(r[0].anchor));
	// §1 事实三：定位证明不了「这句话被这段原文支持」。这条断言把这个边界钉死，
	// 免得将来有人看到 anchor==="exact" 就当成"已核实"。
	const nonsense = validateFacts([
		{ text: "地球是平的", quote: "拉格朗日中值定理是罗尔定理的推广" },
	], SRC);
	ok("语义无关的要点照样能『定位到』—— 这正是它不叫 verified 的原因",
		nonsense[0].anchor === "exact");
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
	// 引文定位只保证「和文件一致」，冻结对账才保证「文件和摄入时一致」
	const tampered = await readSource(dir, meta.sourceId);
	const r = validateFacts([{ text: "偷加的", quote: "偷偷加的一句" }], tampered.text);
	ok("篡改后的内容能骗过引文定位（所以必须先查冻结）", r[0].anchor === "exact");
	ok("但冻结对账拦得住它", (await verifySource(dir, meta.sourceId)).intact === false);

	ok("sourceIdFor 对同一内容稳定", sourceIdFor(SRC).sourceId === sourceIdFor(SRC).sourceId);
	void readFile;
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
