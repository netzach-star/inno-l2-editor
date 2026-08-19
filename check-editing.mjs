#!/usr/bin/env node
// 编辑能力基线里那几件的核验。跑法：node check-editing.mjs
//
// 无需服务、无需 API key、无需浏览器。
//
// 覆盖 2026-08-17 第二轮做的六项里**能在 Node 里测的那部分**：
//   · U-B diff 引擎（字级 LCS / 吸收 / 降级 / 规模护栏 / 条目级配对）
//   · [[ ]] 补全的上下文判定（什么时候该弹、什么时候不该弹）
//   · 撤销栈的快照比较（什么算"没变化"）
//   · 标签浏览器与类型选择的接线（对着 index.html / server.mjs 查）
//
// 碰 DOM 的那些（补全面板画在哪、查找高亮、diff 的配色）不在这里——
// 它们要浏览器，归实测那一档，记在执行决议 D-21。

import { readFile } from "node:fs/promises";
import { loadPure } from "./render-probe.mjs";

let pass = 0, fail = 0;
const failures = [];
const c = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (name, cond, detail) => {
	if (cond) { pass++; console.log(`  ${c.g}✓${c.x} ${name}`); }
	else { fail++; failures.push(name); console.log(`  ${c.r}✗${c.x} ${name}`); if (detail) console.log(`      ${c.d}${detail}${c.x}`); }
};

const P = await loadPure();
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const server = await readFile(new URL("./server.mjs", import.meta.url), "utf8");

/** 把 ops 压成好读的字符串，断言失败时能一眼看出错在哪。 */
const show = (ops) => ops.map((o) => `${o.t}${o.v.join("")}`).join("|");

console.log("\n  U-B diff 引擎\n");

{
	const r = P.diffText("全微分与隐函数定理", "全微分和隐函数定理");
	ok("字级 diff：只标真正变了的那个字",
		show(r.ops) === "=全微分|-与|+和|=隐函数定理", show(r.ops));
	ok("相似度按两侧总长算", Math.abs(r.similarity - 16 / 18) < 1e-9, String(r.similarity));
	ok("默认走字级", r.unit === "char", r.unit);
}
{
	// ② 吸收：两处改动之间只隔 ≤2 个字时，中间那截也算进改动，
	//    否则会出现「改、改」这种一个字一个字闪的效果
	const r = P.diffText("甲、乙", "丙、丁");
	ok("吸收：间隔 ≤2 字的相同段被并进改动",
		!r.ops.some((o) => o.t === "=" && o.v.join("") === "、"), show(r.ops));
}
{
	const r = P.diffText("aaaaaXbbbbbbbbbbYccccc", "aaaaaZbbbbbbbbbbWccccc");
	ok("不吸收：间隔够长的相同段保留下来",
		r.ops.some((o) => o.t === "=" && o.v.length > P.ABSORB_GAP), show(r.ops));
}
{
	// ③ 降级：模型整段重写时不画 diff
	const r = P.diffText("连续函数在闭区间上一致连续", "设 f 可导且导数恒为零则 f 是常值映射");
	ok("相似度过低时 degraded 为真（退回并排）", r.degraded === true, String(r.similarity));
	const keep = P.diffText("连续函数在闭区间上一致连续", "连续函数在闭区间上必定一致连续");
	ok("小改动不降级", keep.degraded === false, String(keep.similarity));
	ok("降级阈值就是设计里的 40%", P.DIFF_MIN_SIMILARITY === 0.4, String(P.DIFF_MIN_SIMILARITY));
}
{
	// 规模护栏：超过 4e6 个格子就先按句切，别把界面卡住
	const long = "这是一句话。".repeat(400);          // 2400 字
	const t = P.diffTokens(long, long + "补一句。");
	ok("超大输入退回句级（不做 4e6 格以上的 LCS）", t.unit === "sentence", `unit=${t.unit}`);
	const small = P.diffTokens("短", "短短");
	ok("小输入仍是字级", small.unit === "char", small.unit);
	ok("护栏阈值是 4e6 格", P.DIFF_CELL_CAP === 4000000, String(P.DIFF_CELL_CAP));
}
{
	const t0 = Date.now();
	const a = "微积分基本定理说明了微分与积分互为逆运算。".repeat(90);   // ≈1900 字
	const b = a.replace(/逆运算/g, "互逆的运算");
	const r = P.diffText(a, b);
	const ms = Date.now() - t0;
	ok("接近上限的输入仍是字级且跑得动（< 3 秒）",
		r.unit === "char" && ms < 3000, `${a.length} 字，耗时 ${ms}ms`);
}
{
	ok("空对空不炸", P.diffText("", "").ops.length === 0);
	ok("从空到有全是新增", show(P.diffText("", "新内容").ops) === "+新内容");
	ok("从有到空全是删除", show(P.diffText("旧内容", "").ops) === "-旧内容");
	const same = P.diffText("一模一样", "一模一样");
	ok("完全相同：没有任何改动段", !same.ops.some((o) => o.t !== "="), show(same.ops));
	ok("完全相同：相似度 1、不降级", same.similarity === 1 && !same.degraded);
}
{
	const r = P.diffText("abc", "axc");
	const t = P.diffTally(r);
	ok("改动账：加一个字、删一个字", t.add === 1 && t.del === 1, JSON.stringify(t));
	ok("改动账：保留率是整数百分比", Number.isInteger(t.pct), String(t.pct));
}

console.log("\n  条目级 diff（「重新整理」用）\n");

{
	const rows = P.diffItems(
		["柯西准则给出收敛的充要条件", "一致连续强于连续", "要被删掉的那条"],
		["柯西准则给出收敛的充分必要条件", "一致连续强于连续", "全新的一条"],
	);
	const kinds = rows.map((r) => r.kind);
	ok("同一条被改写 → changed", kinds[0] === "changed", kinds.join(","));
	ok("一字未动 → same", kinds[1] === "same", kinds.join(","));
	ok("旧的没配上 → removed", kinds.includes("removed"), kinds.join(","));
	ok("新的没配上 → added", kinds.includes("added"), kinds.join(","));
	ok("条数守恒：3 旧 + 1 新增 = 4 行", rows.length === 4, String(rows.length));
}
{
	// 配对阈值：差太远的两条不该被硬凑成"改写"
	const rows = P.diffItems(["级数收敛判别法"], ["拉格朗日中值定理的几何意义"]);
	ok("差太远的两条判成一删一增，不硬凑成改写",
		rows.length === 2 && rows.some((r) => r.kind === "removed") && rows.some((r) => r.kind === "added"),
		rows.map((r) => r.kind).join(","));
}
{
	ok("空的上一版：全部算新增",
		P.diffItems([], ["甲", "乙"]).every((r) => r.kind === "added"));
	ok("空的新版：全部算删除",
		P.diffItems(["甲", "乙"], []).every((r) => r.kind === "removed"));
}

console.log("\n  [[ ]] 链接补全的上下文判定\n");

{
	const at = (s) => P.acContext(s, s.length);
	ok("刚打开 [[ 就该弹", at("看 [[")?.q === "", JSON.stringify(at("看 [[")));
	ok("打了几个字：带上已输入的部分", at("看 [[柯西")?.q === "柯西", JSON.stringify(at("看 [[柯西")));
	ok("已经闭合就不该弹", at("看 [[柯西]]") === null);
	ok("根本没有 [[ 不该弹", at("普通正文") === null);
	ok("跨行不该弹（[[ 在上一行）", at("看 [[\n新一行") === null);
	ok("连着两个 [[ 取最近的那个", at("[[甲]] 又 [[乙")?.q === "乙", JSON.stringify(at("[[甲]] 又 [[乙")));
	const s = "看 [[柯西]] 收尾";
	ok("光标在闭合链接之后不该弹", P.acContext(s, s.length) === null);
	// 「看 [[柯」= 看(0) 空格(1) [(2) [(3) 柯(4)，所以 from 是 4 —— 头一版这条断言我自己数错了
	ok("from 指向 [[ 之后的第一个字", at("看 [[柯")?.from === 4, JSON.stringify(at("看 [[柯")));
}

console.log("\n  撤销栈的快照比较\n");

{
	const base = { body: "正文", tags: ["a"], links: ["X"], status: "draft", confidence: "medium" };
	const same = { body: "正文", tags: ["a"], links: ["X"], status: "draft", confidence: "medium" };
	ok("等价快照判为相同（不会压进一堆空步）", P.sameSnap(base, same));
	ok("正文变了要判为不同", !P.sameSnap(base, { ...base, body: "改了" }));
	ok("标签变了要判为不同", !P.sameSnap(base, { ...base, tags: ["a", "b"] }));
	ok("关联变了要判为不同", !P.sameSnap(base, { ...base, links: [] }));
	ok("status 变了要判为不同", !P.sameSnap(base, { ...base, status: "reviewed" }));
	ok("confidence 变了要判为不同", !P.sameSnap(base, { ...base, confidence: "high" }));
}

console.log("\n  接线（对着源码查，防止改回去）\n");

{
	ok("面板增删都记进历史（§17 说浏览器原生撤销覆盖不到这里）",
		/b\.onclick = \(\) => \{ mark\(\); onRemove\(it\); \}/.test(html)
		&& /function pick\(kind, value\) \{\n  mark\(\);/.test(html));
	ok("status / confidence 改动也记进历史",
		(html.match(/mkSelect\("状态"[\s\S]{0,80}mark\(\)/) ?? []).length > 0
		&& (html.match(/mkSelect\("可信度"[\s\S]{0,80}mark\(\)/) ?? []).length > 0);
	ok("连续打字合并成一步（否则 ⌘Z 一次只退一个字）", /mark\(700\)/.test(html));
	ok("换页清空撤销历史（不然在 A 页 ⌘Z 会写进 B 页的内容）",
		/resetHistory\(\); acClose\(\);/.test(html));
	ok("⌘Z / ⌘⇧Z 在 textarea 里也接管（一套历史，不要两套）",
		/e\.shiftKey \? redo\(\) : undo\(\)/.test(html));
	ok("⌘F 走自己的查找（浏览器的找不到编辑态源码）", /key === "f"/.test(html));
	ok("标签可点筛选，且与类型过滤并存",
		/S\.tagFilter = S\.tagFilter === t\.name \? null : t\.name/.test(html)
		&& /p\.type === type && byTag\(p\)/.test(html));
	ok("类型药丸的计数跟着标签筛子走（数字要和列出来的一致）",
		/const inTag = \(p\) =>/.test(html));
	ok("U-I：生成确认界面把 type 送到服务端", /type: G\.type,/.test(html));
	ok("U-I：只给 concept / entity 两个值（analysis 按 §9 不进本版）",
		/\["concept", "概念"/.test(html) && /\["entity", "实体"/.test(html)
		&& !/\["analysis"/.test(html));
	ok("服务端认这个 type（早就认，缺的一直是界面）",
		/payload\.type === "entity" \? "entity" : "concept"/.test(server));
	ok("catalog 与 /api/page 用同一套 frontmatter 解析（否则块序列 tags 会漏）",
		/const fields = readFields\(raw\);/.test(server) && !/parseInlineArray\(readField/.test(server));
	ok("润色弹窗默认给 diff、可切看全文", /P\.showFull \? "看改动" : "看全文"/.test(html));
	ok("采用润色是一步可撤销的改动", /function acceptPolish\(\) \{\n  mark\(\);/.test(html));
}

console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) {
	console.log("  失败项：");
	for (const f of failures) console.log(`    · ${f}`);
	console.log("");
	process.exit(1);
}
