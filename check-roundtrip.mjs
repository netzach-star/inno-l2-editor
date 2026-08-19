#!/usr/bin/env node
// §17「格式往返」一级往返断言。跑法：node check-roundtrip.mjs
//
// 无需服务、无需 API key、无需浏览器。
//
// ── 这是什么 ──
// §17 完成定义要求「格式往返」那一组的四项——**表格 / 围栏代码块 / 图片 / 公式**——
// 各有一条**一级往返断言**：
//
//     写入 → 存盘 → 重新读取渲染，源码字节不变、渲染结果与写入时一致。
//
// 分两级是 2026-08-07 拆的：一级不依赖导出（本文件），
// 二级是「导出 → 在真实 Obsidian 里打开」，属批次四。
//
// ⚠️ **在 2026-08-17 之前，这一级一条都没有。**
// 当时以为 check-math.mjs 那 20 条算数——不算：它测的全是**渲染方向**的前置处理，
// 没有一条走「存盘 → 重读」。这个误认已记进 §17 完成定义与 D-20。
//
// ── 为什么不用起服务 ──
// 「存盘」这条路真正做事的是 frontmatter.mjs 的字节区间写回（replaceBody /
// patchFrontmatter），服务端只是调用方。直接对着它做往返，测的是同一段代码，
// 而且能进"无 key 那一档"、改完随手就能跑。

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBodyRaw, replaceBody, patchFrontmatter } from "./frontmatter.mjs";
import { loadRenderer, freshMarked } from "./render-probe.mjs";

let pass = 0, fail = 0;
const failures = [];
const c = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (name, cond, detail) => {
	if (cond) { pass++; console.log(`  ${c.g}✓${c.x} ${name}`); }
	else { fail++; failures.push(name); console.log(`  ${c.r}✗${c.x} ${name}`); if (detail) console.log(`      ${c.d}${detail}${c.x}`); }
};

const katex = (await import("katex")).default;
const dir = await mkdtemp(join(tmpdir(), "l2-roundtrip-"));

const FRONTMATTER = [
	"---",
	"title: 往返探针页",
	"type: concept",
	"tags:",
	"  - 测试",
	"status: draft",
	"confidence: medium",
	"created: 2026-08-17",
	"updated: 2026-08-17",
	"---",
	"",
].join("\n");

/**
 * 一次完整往返：写盘 → 读回 → 再渲染。
 *
 * 刻意走**两条**存盘路径，因为真实使用里两条都会发生：
 *   ① replaceBody      —— 用户改了正文
 *   ② patchFrontmatter —— 用户只改了标签（正文一个字节都不该动）
 */
async function roundtrip(name, body) {
	const file = join(dir, `${name}.md`);
	const original = FRONTMATTER + body;
	await writeFile(file, original, "utf8");

	// ① 正文原样写回一遍
	const readBack1 = await readFile(file, "utf8");
	const rewritten = replaceBody(readBack1, readBodyRaw(readBack1));
	await writeFile(file, rewritten, "utf8");

	// ② 只改标签
	const readBack2 = await readFile(file, "utf8");
	const tagged = patchFrontmatter(readBack2, { tags: ["测试", "往返"] });
	await writeFile(file, tagged, "utf8");

	const final = await readFile(file, "utf8");
	return {
		bodyBefore: readBodyRaw(original),
		bodyAfter: readBodyRaw(final),
		final,
	};
}

/** 每个用例一份干净的 marked：扩展是叠加注册的。 */
const render = async (src) => {
	const { renderMd } = await loadRenderer({ marked: await freshMarked(), katex });
	return renderMd(src);
};

console.log("\n  §17 格式往返 · 一级断言（写入 → 存盘 → 重读 → 渲染）\n");

const CASES = [
	{
		key: "表格",
		element: /<table[\s\S]*?<\/table>/,
		body: [
			"## 判别法对照",
			"",
			"| 判别法 | 适用范围 | 结论 |",
			"|---|---:|:--|",
			"| 比值判别法 | 正项级数 | `L < 1` 收敛 |",
			"| 根值判别法 | 正项级数 | 更强 |",
			"",
		].join("\n"),
	},
	{
		key: "围栏代码块",
		element: /<pre><code[\s\S]*?<\/code><\/pre>/,
		body: [
			"## 示例",
			"",
			"```python",
			"def f(n):",
			"    if n < 2:          # 缩进与 < 都要活着回来",
			"        return 1",
			"    return n * f(n - 1)",
			"```",
			"",
		].join("\n"),
	},
	{
		key: "图片",
		element: /<img[^>]*src=/,
		body: [
			"## 图示",
			"",
			"![中值定理的几何意义](img/mvt.png)",
			"",
			"上图说明割线与切线平行。",
			"",
		].join("\n"),
	},
	{
		key: "公式",
		element: /katex/,
		body: [
			"## 巴塞尔问题",
			"",
			"行内的 \\(\\varepsilon\\) 与块级：",
			"",
			"\\[",
			"\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}",
			"\\]",
			"",
		].join("\n"),
	},
];

for (const { key, element, body } of CASES) {
	console.log(`  ── ${key} ──`);
	const { bodyBefore, bodyAfter } = await roundtrip(key, body);

	// 一、源码字节不变
	ok(`${key}：存盘往返后正文**逐字节**不变`,
		bodyBefore === bodyAfter,
		bodyBefore === bodyAfter ? "" : `before=${JSON.stringify(bodyBefore)}\n      after =${JSON.stringify(bodyAfter)}`);

	// 二、渲染结果与写入时一致
	const htmlBefore = await render(bodyBefore);
	const htmlAfter = await render(bodyAfter);
	ok(`${key}：重读之后渲染结果与写入时一致`, htmlBefore === htmlAfter);

	// 三、这一项真的被渲染出来了——否则上面两条在"两边都渲染失败"时也会绿
	ok(`${key}：确实渲染成了对应元素（不是两边一样地没渲染）`,
		element.test(htmlAfter), htmlAfter.slice(0, 220));
}

/* ---------------- 四项之外：几条容易在往返里被磨掉的细节 ---------------- */

console.log("\n  ── 往返里最容易被磨掉的细节 ──");

{
	const body = "## 空行与尾随空格\n\n\n三个连续空行在上面。\n行尾有两个空格  \n结束。\n";
	const { bodyBefore, bodyAfter } = await roundtrip("空白", body);
	ok("连续空行没被压掉", bodyAfter.includes("\n\n\n"));
	ok("行尾空格没被 trim 掉", bodyAfter.includes("空格  \n"));
	ok("整段正文仍然逐字节相等", bodyBefore === bodyAfter);
}
{
	// 代码块里出现 markdown 记号与 HTML 标签——两样都不该在往返里被改写
	const body = "```html\n<div class=\"x\">**不是粗体**</div>\n```\n";
	const { bodyBefore, bodyAfter } = await roundtrip("代码块内容", body);
	ok("代码块里的 HTML 标签在磁盘上原样留着", bodyAfter.includes('<div class="x">'));
	ok("代码块里的 ** 在磁盘上原样留着", bodyAfter.includes("**不是粗体**"));
	ok("整段正文仍然逐字节相等", bodyBefore === bodyAfter);
	const out = await render(bodyAfter);
	ok("渲染时代码块里的标签被转义、不注入 DOM", !/<div class="x">/.test(out) && out.includes("&lt;div"), out.slice(0, 200));
	ok("渲染时代码块里的 ** 不被当粗体", !out.includes("<strong>"), out.slice(0, 200));
}
{
	// wikilink 是本项目的专有语法，往返里同样不能被动
	const body = "关联 [[柯西收敛准则]] 与别名 [[极限|极限概念]]。\n";
	const { bodyBefore, bodyAfter } = await roundtrip("wikilink", body);
	ok("wikilink 在磁盘上原样留着", bodyAfter === bodyBefore && bodyAfter.includes("[[极限|极限概念]]"));
	const out = await render(bodyAfter);
	ok("别名渲染成「显示后半段、链到前半段」（D-19 的口径）",
		out.includes('data-link="极限"') && out.includes(">极限概念<"), out);
}

await rm(dir, { recursive: true, force: true });

console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) {
	console.log("  失败项：");
	for (const f of failures) console.log(`    · ${f}`);
	console.log("");
	process.exit(1);
}
