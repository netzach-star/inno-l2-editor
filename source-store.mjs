// 冻结来源：摄入后不可变，内容寻址。
//
// 「冻结」不是一句承诺，是可核验的事实：sourceId 由内容 hash 决定，
// 任何时候都能重算 hash 和 meta 对账（verifySource）。改了原件，对账立刻失败。
// 这是引文校验能成立的前提——没有一份确定没变过的原文，「精确子串」就没有意义。

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSourceText } from "./citation.mjs";

const RAW = "raw.md";
const META = "meta.json";

export function sourceIdFor(text) {
	const sha = createHash("sha256").update(normalizeSourceText(text), "utf8").digest("hex");
	return { sourceId: `src_${sha.slice(0, 12)}`, sha256: `sha256:${sha}` };
}

export async function listSources(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		try {
			const meta = JSON.parse(await readFile(join(dir, e.name, META), "utf8"));
			out.push(meta);
		} catch {
			// 目录坏了就跳过，不让一份坏数据搞垮整个列表
		}
	}
	return out.sort((a, b) => String(b.ingestedAt).localeCompare(String(a.ingestedAt)));
}

export async function readSource(dir, sourceId) {
	const base = join(dir, sourceId);
	const meta = JSON.parse(await readFile(join(base, META), "utf8"));
	const text = await readFile(join(base, RAW), "utf8");
	return { meta, text };
}

// 重算 hash 与 meta 对账。冻结这件事靠这个函数说话，而不是靠文档里写一句「不可变」
export async function verifySource(dir, sourceId) {
	const { meta, text } = await readSource(dir, sourceId);
	const { sha256 } = sourceIdFor(text);
	return { sourceId, intact: sha256 === meta.sha256, expected: meta.sha256, actual: sha256 };
}

/**
 * 多段拼接的分隔线。它是冻结内容的一部分，因此引文校验照常成立：
 * 跨段的引文匹配不上（本来也不该匹配），段内的照抄一字不差就通过。
 */
const SEG_SEP = "\n\n---\n\n";

/**
 * 摄入一份来源。内容寻址 ⇒ 天然幂等：
 * 同一份内容再摄入一次，拿到的是同一个 sourceId，且**不覆写**已有文件。
 *
 * 接受一段（`text`）或多段（`segments`）。多段是给「把 AI 的几轮回答攒成一份资料」用的：
 * 上游 `raw/uploads/` 装的本来就是「用户归档了什么」，在 agent 产品里那大量就是对话。
 * 冻结与引文校验对来源是教科书还是对话记录一视同仁——它们防的是**编译子代理瞎编**，
 * 跟来源本身对不对是两件事（来源对不对，系统对任何来源都没承诺过）。
 */
export async function ingestSource(dir, { filename, text, segments, title }) {
	const parts = Array.isArray(segments) && segments.length > 0
		? segments.map((s) => normalizeSourceText(String(s ?? ""))).filter((s) => s.trim().length > 0)
		: [normalizeSourceText(String(text ?? ""))].filter((s) => s.trim().length > 0);
	if (parts.length === 0) throw new Error("来源是空的");

	const normalized = normalizeSourceText(parts.join(SEG_SEP));
	const { sourceId, sha256 } = sourceIdFor(normalized);
	const base = join(dir, sourceId);

	try {
		await stat(join(base, META));
		// 已经有了。冻结的东西不重写，直接返回既有的
		const meta = JSON.parse(await readFile(join(base, META), "utf8"));
		return { meta, alreadyFrozen: true };
	} catch {
		// 还没有，继续摄入
	}

	await mkdir(base, { recursive: true });
	const name = (title || filename || sourceId).replace(/\.[^.]+$/, "");
	const meta = {
		sourceId,
		title: name,
		filename: filename || `${name}.md`,
		// 与上游 raw/uploads/ 的 frontmatter 同名同义
		source_type: "markdown",
		sha256,
		chars: normalized.length,
		segments: parts.length,
		ingestedAt: new Date().toISOString(),
		frozen: true,
	};
	await writeFile(join(base, RAW), normalized, "utf8");
	await writeFile(join(base, META), JSON.stringify(meta, null, 2), "utf8");
	return { meta, alreadyFrozen: false };
}
