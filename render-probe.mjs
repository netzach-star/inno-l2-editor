// 核验用的取样器，**不是产品代码**。check-math.mjs 与 check-roundtrip.mjs 共用它。
//
// 项目是单文件前端、无构建，所以没有 import 可用。取的办法是按函数名定位再 eval——
// 依赖两个锚点函数名，改名了这里会**立刻报错**，而不是静默跳过。
// （静默跳过的核验等于没有：它会一直绿着，测的却是一段已经不存在的代码。）

import { readFile } from "node:fs/promises";

const START = "function escapeHtmlKeepMarkdown";
const END_ANCHOR = "renderer: buildRenderer(m),";

/**
 * 从 index.html 里把渲染那一段抠出来，注入依赖后返回可调用的函数。
 *
 * @param {object} deps
 * @param {any} [deps.marked] 传 undefined 就是"没装 marked"那条降级路径
 * @param {any} [deps.katex]  传 undefined 就是"没装 katex"那条降级路径
 */
export async function loadRenderer({ marked, katex } = {}) {
	const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
	const start = html.indexOf(START);
	const endAnchor = html.indexOf(END_ANCHOR, start);
	if (start < 0 || endAnchor < 0) {
		throw new Error(
			`在 index.html 里找不到渲染段的锚点（${START} … ${END_ANCHOR}）。\n` +
			"    它被改名或重构了，本文件与两个 check 脚本要跟着改。",
		);
	}
	const end = html.indexOf("\n}", endAnchor) + 2;
	const code = html.slice(start, end);

	// esc 定义在 index.html 更靠前的地方，这里按同一份实现注入
	const esc = (s) => String(s).replace(/[&<>"]/g, (ch) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

	// console.warn 在降级路径上会被打到，核验时不需要看
	const quietConsole = { warn() {}, error() {}, log: console.log };

	// eslint-disable-next-line no-new-func
	const factory = new Function("marked", "katex", "esc", "console",
		`${code}\nreturn { renderMd, escapeHtmlKeepMarkdown, unescapeTex, renderTex, ensureMarked };`);
	return factory(marked, katex, esc, quietConsole);
}

/** 每次都要一份干净的 marked：扩展是叠加注册的，跨用例复用会叠出多份同名扩展。 */
export async function freshMarked() {
	const { Marked } = await import("marked");
	return new Marked();
}
