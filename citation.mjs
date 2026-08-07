// 引文校验：模型写下的每一条事实，都必须能在冻结来源里逐字找到。
//
// 这是红线 2，也是演示场景②「这条是不是编的」的全部实现。
// 规范化逻辑逐字移植自
//   扩展v3.0在建/packages/knowledge-contracts/src/canonical.ts
//   扩展v3.0在建/packages/knowledge-compiler-core/src/source-index.ts
// 两边不能各写一套——这是上游 wiki-links.ts 已经踩过的坑。

// 存储形：来源冻结下来时用这个形状算 hash、写文件
export function normalizeSourceText(value) {
	return value.replace(/\r\n?/g, "\n").normalize("NFC").trimEnd();
}

/**
 * 比较用规范形，只用于 quote 子串校验，不写回存储、不参与任何 hash。
 *
 * 为什么不直接在存储形上 includes：PDF / DOCX / OCR 提取出来的文本里，
 * 行尾断字连字符、软连字符、ligature、全角半角混排都会让**合法**引用匹配失败，
 * 结果是模型明明照抄了原文却被判成编造。
 *
 * 刻意不做大小写折叠——大小写是有意义的事实差异。
 *
 * ⚠️ 这里比上游 canonical.ts 多一步：**去掉两个中日韩字符之间的空白**。
 *
 * 上游那套是为空格分词的语言设计的：把空白折叠成一个半角空格，词边界还在。
 * 中文不是这样——PDF 在句子中间换行是常态，而中文换行处没有空格也没有连字符，
 * 上游的 `[-‐‑]\n` 规则接不住。结果是：
 *
 *     原文  「拉格朗日中值定理是罗尔定理的推广」
 *     PDF   「拉格朗日中值定\n理是罗尔定理的推广」
 *     折叠后「拉格朗日中值定 理是罗尔定理的推广」  ← 多了个空格，匹配失败
 *
 * 模型明明一字不差照抄了，却被判成编造。本项目的语料就是中文数学笔记，
 * 这个假阴性会高频发生，正是上游注释里说要避免的那类问题。
 *
 * 会不会因此放过编造的引文？不会。这一步只动空白，从不删除任何实体字符，
 * 所以「把原文里相隔很远的两段拼起来」照样匹配不上（check-citation.mjs 里有这条断言）。
 * 能因此通过的，只有本来就在原文里连续、仅仅被换行切开的片段——那本来就该通过。
 *
 * 若将来接回重型后端，这一步应当反向合并进上游 canonical.ts，而不是让两边各写一套。
 */
// 中日韩文字 + 全角标点。中文里换行不是词的分隔符，这一点和英文相反
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303F\\uFF00-\\uFFEF";
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "gu");

/**
 * 第 0 层：剥掉 Markdown 强调记号与 `[[ ]]` 的方括号（**保留其中的文字**）。
 *
 * 为什么（设计文档 §1「事实二」）：现在的校验是规范化之后的**精确子串**匹配，
 * 而模型抄原文时最常丢的恰恰是这些记号——原文写 `**拉格朗日中值定理**`，
 * 模型抄成 `拉格朗日中值定理`，于是被判成"核不上"。
 *
 * 那是**误杀**。而误杀在界面上和编造长得一模一样，都是一个红叉——
 * 用户看到只会觉得产品不行。
 *
 * 这一层是**精确的**，不引入任何模糊性：它只删记号字符本身，从不删实体文字，
 * 所以"把原文里相隔很远的两段拼起来"照样匹配不上（check-citation.mjs 有这条断言）。
 * 模糊重锚（8-gram + LCS）是 A2 的事，按 0.6 后移，这里没有。
 *
 * 沿用同一条纪律：**规范形只用于比对，不写回存储、不参与任何 hash。**
 */
function stripMarkdownMarks(s) {
	return s
		// [[目标|显示]] / [[页面]] → 保留方括号里的文字（取 | 前半段，与 normalizeWikiLink 同口径）
		.replace(/\[\[([^\]]+)\]\]/gu, (_, inner) => inner.split("|")[0])
		// 强调记号：**粗体** *斜体* _下划_ `代码`
		.replace(/[*_`]/gu, "");
}

export function normalizeForQuoteMatch(value) {
	return stripMarkdownMarks(
		value
			.replace(/\r\n?/g, "\n")
			.normalize("NFKC")
			// 软连字符与零宽字符
			.replace(/[­​‌‍﻿]/gu, "")
			// PDF 行尾断字：连字符 + 换行
			.replace(/[-‐‑]\n/gu, ""),
	)
		// 所有 Unicode 空白折叠为单个半角空格
		.replace(/\s+/gu, " ")
		// ↓ 相对上游 canonical.ts 的**唯一扩展**，理由见下方长注释
		.replace(CJK_GAP, "")
		.trim();
}

export const MAX_QUOTE_CHARS = 500;

/**
 * 定位一条要点的引文。返回 null 表示定位到了，否则返回定位不到的原因。
 * 只有「定位到」与「没定位到」两种结果——没有「警告后放行」，
 * 因为红线 2 写的是必须，不是应该。
 */
export function checkQuote(quote, normalizedSource) {
	if (typeof quote !== "string" || quote.trim().length === 0) {
		return { code: "MISSING_QUOTE", message: "这条没有附引文，无法核对" };
	}
	if (quote.length > MAX_QUOTE_CHARS) {
		return {
			code: "QUOTE_TOO_LONG",
			message: `引文 ${quote.length} 字，超过上限 ${MAX_QUOTE_CHARS}`,
		};
	}
	const needle = normalizeForQuoteMatch(quote);
	if (needle.length === 0) {
		return { code: "MISSING_QUOTE", message: "引文规范化后为空" };
	}
	if (!normalizedSource.includes(needle)) {
		return {
			code: "QUOTE_NOT_IN_SOURCE",
			message: "在冻结来源里找不到这段话——可能是模型编的，也可能是它改写过",
		};
	}
	return null;
}

/**
 * 逐条**定位**模型产出的要点。
 *
 * ── 为什么这里叫「定位」而不是「校验」（设计文档 §1 事实三 + 0.5）──
 *
 * 这段代码能证明的只有一件事：**这段 quote 出现在冻结来源的某个位置**。
 * 它**完全没有**验证 `text` 是不是被 `quote` 支持。所以下面这条能顺利通过：
 *
 *     { text: "地球是平的", quote: "拉格朗日中值定理是罗尔定理的推广" }
 *
 * 把这个字段叫 `verified`（已核验）是**名不副实**的，它踩红线 3。
 * 误杀损失的是内容，而名不副实损失的是用户对整个系统的信任基准——后者更严重。
 * 所以字段改成 `anchor`：**只做了定位就叫定位。**
 *
 * 取值：
 *   `exact`  在来源里精确定位到了
 *   `none`   没定位到
 *
 * 设计文档还留了一档 `fuzzy`（模糊重锚，8-gram + LCS），属 A2，**按 0.6 后移**，
 * 本批次不产生这个值。消费方仍应按三值处理，免得 A2 落地时到处要改。
 *
 * 定位不到的**不丢掉**，原样带着 `anchor: "none"` 返回——
 * 让用户看见「模型说了这个，但找不到出处」，比悄悄删掉诚实得多（红线 3）。
 */
export function validateFacts(facts, sourceText) {
	const normalizedSource = normalizeForQuoteMatch(sourceText);
	return facts.map((f, i) => {
		const text = typeof f?.text === "string" ? f.text.trim() : "";
		const quote = typeof f?.quote === "string" ? f.quote.trim() : "";
		const problem = text.length === 0
			? { code: "EMPTY_FACT", message: "这条是空的" }
			: checkQuote(quote, normalizedSource);
		return { index: i, text, quote, anchor: problem === null ? "exact" : "none", problem };
	});
}

/** 定位到了没有。`fuzzy`（A2 后移）将来也算定位到，所以判据是「不是 none」。 */
export function isAnchored(fact) {
	return fact?.anchor !== undefined && fact.anchor !== "none";
}
