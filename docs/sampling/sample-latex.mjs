#!/usr/bin/env node
// §15 待决 6 的取样：真实 AI 回答里 LaTeX 的比例。
//
// 用**实际配置的那个模型**（runtime/config/config.json 的 defaultProvider/defaultModel）
// 加**上游的系统提示词**（dist/agent/system-prompt.js 的 INNO_SYSTEM_PROMPT），
// 问 12 个数学分析学习者真会问的问题。
//
// 为什么不用现成的会话记录：全部只有 11 条 assistant 回答，其中只有 2 条是数学内容，
// 而且是"课程大纲"这种不推导的体裁——按 0.3 的教训，那个样本证明不了这件事。
//
// 为什么不走 POST /api/chat：那条会进 agent 循环、可能触发 l2_archive 写页面。
// 这里要测的只有一个变量——**模型讲数学分析时用不用 LaTeX**，
// 所以直接打模型，把 agent 那层的副作用隔离掉。系统提示词照用，因为它是影响输出格式的那部分。

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AGENT = process.argv[2];
if (!AGENT) { console.error("用法：node sample-latex.mjs <inno-agent 目录>"); process.exit(1); }

const cfg = JSON.parse(readFileSync(join(AGENT, "runtime/config/config.json"), "utf8"));
const provider = cfg.providers[cfg.defaultProvider];
const model = cfg.defaultModel;
const sys = (await import(pathToFileURL(resolve(AGENT, "apps/inno-agent/dist/agent/system-prompt.js")).href)).INNO_SYSTEM_PROMPT;

console.log(`  模型：${cfg.defaultProvider} / ${model}`);
console.log(`  系统提示词：${sys.length} 字\n`);

// 学习者真会问的 12 个问题，覆盖不同体裁——
// 概念解释 / 证明 / 解题 / 辨析 / 反例 / 判别法 / 定义理解 / 常见错误
const QUESTIONS = [
	"什么是一致连续？它和普通连续到底差在哪？",
	"证明一下：闭区间上的连续函数必定有界。",
	"拉格朗日中值定理的几何意义是什么？",
	"求极限 lim(x→0) (sin x - x)/x^3，写出过程。",
	"黎曼积分和勒贝格积分的本质区别是什么？",
	"举一个处处连续但处处不可导的函数，并说明为什么。",
	"级数 1/n^p 什么时候收敛？怎么判断？",
	"二重积分换元的时候雅可比行列式是怎么来的？",
	"数列极限的 ε-N 定义该怎么理解？我总觉得绕。",
	"泰勒展开在近似计算里具体怎么用？给个例子。",
	"实数完备性有哪几个等价命题？它们怎么互推？",
	"为什么不能对条件收敛的级数随意重排？",
];

// LaTeX 的判据分两档：**成对的数学环境**（真 LaTeX）与**裸命令**（可能只是顺手写了个 \alpha）
const RE_DELIM = /\$\$[\s\S]{1,400}?\$\$|\$[^$\n]{1,200}\$|\\\([\s\S]{1,200}?\\\)|\\\[[\s\S]{1,400}?\\\]|\\begin\{(equation|align|aligned|cases|pmatrix|bmatrix|array)\}/;
const RE_CMD = /\\(frac|int|sum|prod|lim|sqrt|infty|varepsilon|alpha|beta|delta|theta|partial|forall|exists|leq|geq|neq|to|cdot|ldots|mathbb|mathrm|left|right)\b/;
const RE_UNICODE = /[εδσπθαβγλμ∞∑∏∫√≤≥≠→←↔∀∃∈∉⊂⊆∪∩·×÷±∂∇⁰¹²³⁴ⁿ₀₁₂ₙ]/g;

async function ask(q) {
	const r = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
		body: JSON.stringify({
			model,
			messages: [{ role: "system", content: sys }, { role: "user", content: q }],
			stream: false,
		}),
		signal: AbortSignal.timeout(300_000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const d = await r.json();
	return d.choices?.[0]?.message?.content ?? "";
}

const rows = [];
// 三个一批，别把 API 打爆
for (let i = 0; i < QUESTIONS.length; i += 3) {
	const batch = QUESTIONS.slice(i, i + 3);
	const outs = await Promise.all(batch.map((q) => ask(q).catch((e) => `__ERR__${e.message}`)));
	outs.forEach((txt, k) => {
		const q = batch[k];
		if (txt.startsWith("__ERR__")) {
			console.log(`  ${String(i + k + 1).padStart(2)}. ✗ ${txt.slice(7, 80)}`);
			rows.push({ q, err: txt.slice(7) });
			return;
		}
		const delim = RE_DELIM.test(txt);
		const cmd = RE_CMD.test(txt);
		const uni = (txt.match(RE_UNICODE) ?? []).length;
		rows.push({ q, len: txt.length, delim, cmd, uni, txt });
		console.log(`  ${String(i + k + 1).padStart(2)}. ${String(txt.length).padStart(5)} 字  ` +
			`数学环境=${delim ? "有" : "无"}  LaTeX命令=${cmd ? "有" : "无"}  Unicode符号=${String(uni).padStart(3)}  | ${q.slice(0, 22)}`);
	});
}

const good = rows.filter((r) => !r.err);
const withDelim = good.filter((r) => r.delim).length;
const withCmd = good.filter((r) => r.cmd).length;
const withAny = good.filter((r) => r.delim || r.cmd).length;
const withUni = good.filter((r) => r.uni > 0).length;

console.log(`\n  ── 结果（n=${good.length}）──`);
console.log(`  含成对数学环境（$…$ / $$…$$ / \\[…\\] / begin{}）：${withDelim} / ${good.length}  = ${(withDelim / good.length * 100).toFixed(0)}%`);
console.log(`  含 LaTeX 命令（\\frac \\int …）              ：${withCmd} / ${good.length}  = ${(withCmd / good.length * 100).toFixed(0)}%`);
console.log(`  含任一 LaTeX 特征                           ：${withAny} / ${good.length}  = ${(withAny / good.length * 100).toFixed(0)}%`);
console.log(`  含 Unicode 数学符号（ε δ ∞ ∑ …）            ：${withUni} / ${good.length}  = ${(withUni / good.length * 100).toFixed(0)}%`);

writeFileSync(process.argv[3] ?? "/tmp/latex-sample.json",
	JSON.stringify({ model: `${cfg.defaultProvider}/${model}`, n: good.length, withDelim, withCmd, withAny, withUni, rows }, null, "\t"));
console.log(`\n  原始回答已存到 ${process.argv[3] ?? "/tmp/latex-sample.json"}`);
