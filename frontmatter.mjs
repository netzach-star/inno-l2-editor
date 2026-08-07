// frontmatter 的**字节区间**读写。
//
// 为什么要有这个文件（设计文档 §10.2，U-J-2）：
// V3 文档声称系统只托管 frontmatter 的几个字段，"其余内容一个字节都不动"。
// 实际做不到——旧的 `buildFile()` 有四处会破坏用户内容：
//
//   1. `body.replace(/\n{3,}/g, "\n\n")`  把连续三个以上换行压成两个
//   2. `freeBody.trimEnd()`               砍掉正文末尾的空白
//   3. `readField` / `parseInlineArray`   只认行内 `tags: [a, b]`，
//                                         多行 YAML 数组会被读成空、写回时丢光
//   4. 标题 / 标签 / 来源名未转义就拼进 YAML
//
// 在这条修好之前，文档里不该写"一个字节都不改"——那是红线 3 的问题，不是措辞问题。
//
// ── 这个模块的口径 ──
//
// **托管字段**（`MANAGED_KEYS`）：只有这几个字段的**值区间**会被替换，
// 每次替换都精确到字节偏移，前后左右一个字节都不碰。
// **其余一切**——别的 frontmatter 字段、字段顺序、缩进、注释、空行、正文——原样搬运。
//
// **正文**：不做区间 patch，要改就**整段替换**（与上游 Notebook 的 MDEditor 同语义）。
// 原本那套"只 patch `## 相关知识` 一段"的机制是为双向关联同步服务的，
// 而 §11 已经取消了双向落盘，它跟着一起没了必要。
//
// 零依赖：插件核心不装任何包，所以这里是一个**只认 L2 frontmatter 那个子集**的
// 手写解析器，不是通用 YAML。它认得的形态由上游 `serializeFrontmatter` 决定：
// 标量、行内流式数组 `[a, b]`、以及 `- item` 的块序列。
// 遇到认不出的形态就**原样保留、不去改它**，绝不猜。

/** 只有这几个字段允许被本模块改写。不在表里的一律原样搬运。 */
export const MANAGED_KEYS = ["tags", "status", "confidence", "contested", "updated", "title"];

/**
 * 定位 frontmatter 区间。返回字节偏移，没有 frontmatter 就返回 null。
 *
 * 只认最严格的形态：文件以 `---\n` 开头，后面某一行恰好是 `---`。
 * 认不出就当作"这个文件没有 frontmatter"，一个字节都不动——
 * 宁可少改，也不要在猜不准的文件上乱写。
 */
export function locateFrontmatter(raw) {
	if (!raw.startsWith("---\n") && raw !== "---" && !raw.startsWith("---\r\n")) return null;
	const nl = raw.indexOf("\n");
	if (nl === -1) return null;
	// 逐行找闭合的 `---`
	let pos = nl + 1;
	while (pos <= raw.length) {
		const lineEnd = raw.indexOf("\n", pos);
		const line = (lineEnd === -1 ? raw.slice(pos) : raw.slice(pos, lineEnd)).replace(/\r$/, "");
		if (line.trim() === "---") {
			return {
				innerStart: nl + 1,          // 首个字段所在字节
				innerEnd: pos,               // 闭合 `---` 所在字节
				bodyStart: lineEnd === -1 ? raw.length : lineEnd + 1,
			};
		}
		if (lineEnd === -1) return null;
		pos = lineEnd + 1;
	}
	return null;
}

/**
 * 把 frontmatter 切成若干条目，每条带**字节区间**。
 *
 * 条目 = 一个顶层 `key:` 行，加上它后面所有比它缩进深的续行
 * （块序列 `  - x`、折叠标量等）。这样 `sources:\n  - a\n  - b` 是一个条目，
 * 替换它时那三行一起换掉，不会把 `- b` 落单。
 */
export function parseEntries(raw) {
	const loc = locateFrontmatter(raw);
	if (!loc) return [];
	const entries = [];
	let pos = loc.innerStart;
	while (pos < loc.innerEnd) {
		const lineEnd = raw.indexOf("\n", pos);
		const stop = lineEnd === -1 || lineEnd >= loc.innerEnd ? loc.innerEnd : lineEnd + 1;
		const line = raw.slice(pos, stop).replace(/\r?\n$/, "");
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
		if (m) {
			// 吃掉后续的续行（以空白开头、或以 `- ` 开头的块序列项）
			let end = stop;
			while (end < loc.innerEnd) {
				const nEnd = raw.indexOf("\n", end);
				const nStop = nEnd === -1 || nEnd >= loc.innerEnd ? loc.innerEnd : nEnd + 1;
				const nLine = raw.slice(end, nStop).replace(/\r?\n$/, "");
				if (!/^(\s+\S|\s*-\s)/.test(nLine)) break;
				if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(nLine)) break;
				end = nStop;
			}
			entries.push({
				key: m[1],
				rawValue: m[2],
				start: pos,        // key 行起始字节
				end,               // 本条目（含续行）之后的字节
				valueStart: pos + m[1].length + 1,
				valueEnd: stop === end ? stop - (raw.slice(pos, stop).endsWith("\n") ? 1 : 0) : end,
			});
			pos = end;
		} else {
			pos = stop; // 空行 / 注释 / 认不出的行：跳过，保持原样
		}
	}
	return entries;
}

/* ---------------- 值的读 ---------------- */

function unquote(s) {
	const t = s.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
		const inner = t.slice(1, -1);
		return t[0] === '"'
			? inner.replace(/\\(["\\nt])/g, (_, c) => ({ '"': '"', "\\": "\\", n: "\n", t: "\t" })[c])
			: inner.replace(/''/g, "'");
	}
	return t;
}

/** 读一个条目的值。认三种形态：行内流式数组、块序列、标量。 */
export function readEntryValue(raw, entry) {
	const head = entry.rawValue.trim();
	// 行内流式数组： tags: [a, b]
	if (head.startsWith("[")) {
		const close = head.lastIndexOf("]");
		if (close === -1) return head;
		return head
			.slice(1, close)
			.split(",")
			.map((s) => unquote(s))
			.filter((s) => s.length > 0);
	}
	// 块序列： sources:\n  - a\n  - b
	if (head === "") {
		const rest = raw.slice(entry.start + entry.key.length + 1, entry.end);
		const items = [];
		for (const line of rest.split("\n")) {
			const m = /^\s*-\s+(.*)$/.exec(line);
			if (m) items.push(unquote(m[1]));
		}
		if (items.length > 0) return items;
		return "";
	}
	return unquote(head);
}

/** 把整份 frontmatter 读成对象。认不出的字段值以原始字符串给出。 */
export function readFields(raw) {
	const out = {};
	for (const e of parseEntries(raw)) out[e.key] = readEntryValue(raw, e);
	return out;
}

/* ---------------- 值的写 ---------------- */

/**
 * YAML 标量转义。
 *
 * 旧代码直接把标题 / 标签 / 来源名拼进 YAML，标题里有 `:`、`#`、引号时
 * 产出的 frontmatter 上游解析不了（§10.2 的第 4 条）。
 * 这里的规则取"够用且保守"：凡是可能引起歧义的一律加双引号。
 */
export function yamlScalar(value) {
	const s = String(value);
	if (s === "") return '""';
	// ISO 日期不加引号。上游 `serializeFrontmatter` 写的就是不带引号的
	// `updated: 2026-07-31`，我们加上引号就是一处凭空的格式漂移——
	// 每次保存都会在 diff 里多一行，而且和上游写的同一个字段长得不一样（0.6）。
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
	// 会引起歧义的：YAML 指示符、前后空白、看起来像数字 / 布尔 / null
	const needsQuote =
		/[:#\-?{}[\],&*!|>'"%@`]/.test(s) ||
		/^\s|\s$/.test(s) ||
		/^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
		/^[+-]?(\d|\.\d)/.test(s);
	if (!needsQuote) return s;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** 行内流式数组，与上游 `serializeFrontmatter` 产出的 `[a, b]` 同形。 */
function renderInlineArray(items) {
	return `[${items.map((x) => yamlScalar(x)).join(", ")}]`;
}

/** 块序列，与上游 `sources:\n  - x` 同形。 */
function renderBlockArray(key, items) {
	if (items.length === 0) return `${key}:`;
	return `${key}:\n${items.map((x) => `  - ${yamlScalar(x)}`).join("\n")}`;
}

/**
 * 只替换托管字段的字节区间，其余原样搬运。
 *
 * `updates` 里给了什么就改什么，没给的**碰都不碰**。
 * 数组字段保持它原来的形态（本来是行内就还写行内，本来是块序列就还写块序列）——
 * 换形态会产生一整片无谓的 diff，而 diff 越小，"只改了我要改的"越容易验证。
 *
 * 字段不存在时追加到 frontmatter 末尾。
 */
export function patchFrontmatter(raw, updates) {
	const loc = locateFrontmatter(raw);
	if (!loc) throw new Error("这个文件没有可识别的 frontmatter，拒绝改写");

	const entries = parseEntries(raw);
	const byKey = new Map(entries.map((e) => [e.key, e]));

	// 从后往前替换，这样前面的偏移不会被打乱
	const edits = [];
	const appends = [];

	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) continue;
		if (!MANAGED_KEYS.includes(key)) {
			throw new Error(`${key} 不是托管字段，本模块不改它`);
		}
		const entry = byKey.get(key);
		const isArray = Array.isArray(value);

		if (!entry) {
			appends.push(isArray ? renderBlockArray(key, value) : `${key}: ${yamlScalar(value)}`);
			continue;
		}
		let text;
		if (isArray) {
			// 保持原形态
			const wasInline = entry.rawValue.trim().startsWith("[");
			text = wasInline ? `${key}: ${renderInlineArray(value)}` : renderBlockArray(key, value);
		} else {
			text = `${key}: ${yamlScalar(value)}`;
		}
		// entry.end 可能带着结尾换行，补回去
		const tail = raw.slice(entry.start, entry.end).endsWith("\n") ? "\n" : "";
		edits.push({ start: entry.start, end: entry.end, text: text + tail });
	}

	let out = raw;
	for (const e of edits.sort((a, b) => b.start - a.start)) {
		out = out.slice(0, e.start) + e.text + out.slice(e.end);
	}
	if (appends.length > 0) {
		// 插在闭合 `---` 之前。重算偏移：前面的替换可能改了长度
		const loc2 = locateFrontmatter(out);
		const head = out.slice(0, loc2.innerEnd);
		const needsNl = head.endsWith("\n") ? "" : "\n";
		out = head + needsNl + appends.join("\n") + "\n" + out.slice(loc2.innerEnd);
	}
	return out;
}

/**
 * 整段替换正文。frontmatter 区间一个字节不动。
 *
 * 刻意**不**做 trimEnd、不压换行——那正是 §10.2 要修的两条。
 * 调用方给什么就写什么，只保证文件以恰好一个换行结尾（和上游 writeText 的产物一致）。
 */
export function replaceBody(raw, newBody) {
	const loc = locateFrontmatter(raw);
	const body = newBody.endsWith("\n") ? newBody : `${newBody}\n`;
	if (!loc) return body;
	return raw.slice(0, loc.bodyStart) + body;
}

/** 取正文（frontmatter 之后的全部字节，原样）。 */
export function readBodyRaw(raw) {
	const loc = locateFrontmatter(raw);
	return loc ? raw.slice(loc.bodyStart) : raw;
}
