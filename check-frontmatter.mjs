#!/usr/bin/env node
// frontmatter 字节区间写回的核验（设计文档 §10.2 / U-J-2 的完成定义）。
//
// 这一组断言的重点全在**字节**上：
//   「只改标签」「只改 status / confidence」两种操作，
//   正文与其余 frontmatter 字段的字节序列必须**完全不变**。
//
// 无需服务、无需 API key。跑法：node check-frontmatter.mjs

import {
	MANAGED_KEYS,
	locateFrontmatter,
	parseEntries,
	patchFrontmatter,
	readBodyRaw,
	readFields,
	replaceBody,
	yamlScalar,
} from "./frontmatter.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
	if (cond) {
		pass++;
		console.log(`  \x1b[32m✓\x1b[0m ${name}`);
	} else {
		fail++;
		failures.push(name);
		console.log(`  \x1b[31m✗\x1b[0m ${name}`);
		if (detail) console.log(`      ${detail}`);
	}
}

function eq(name, actual, expected) {
	ok(name, actual === expected, actual === expected ? "" : `期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

/* ---------------- 语料 ---------------- */

// 上游 serializeFrontmatter 的真实产物形态：tags 行内、sources/source_ids 块序列
const UPSTREAM = `---
title: 一致收敛
created: 2026-07-31
type: concept
tags: [concept, 一致收敛, 函数项级数]
sources:
  - wiki/sources/数分笔记-abc123.md
source_ids:
  - l2src_abc12345
updated: 2026-07-31
status: draft
confidence: medium
---
# 一致收敛

## 定义

设函数列 {f_n} 在区间 I 上收敛于 f。


上面**故意**留了两个空行，用来验证「不压换行」。
末尾也故意留了尾随空格与空行：
` + "行尾有三个空格 →   \n\n\n";   // 用拼接写，免得尾随空格被编辑器/格式化吃掉

// 用户在 Obsidian 里手写的多行 YAML 数组（旧 parseInlineArray 会把它读成空）
const MULTILINE_TAGS = `---
title: 测试页
tags:
  - 数学分析
  - 极限
status: draft
---
正文一行。
`;

console.log("\n  frontmatter 字节区间写回\n");

/* ---------------- 1. 定位与解析 ---------------- */

const loc = locateFrontmatter(UPSTREAM);
ok("能定位 frontmatter 区间", loc !== null);
eq("bodyStart 落在正文首字节", UPSTREAM.slice(loc.bodyStart, loc.bodyStart + 6), "# 一致收敛");

const entries = parseEntries(UPSTREAM);
eq("解析出 9 个顶层字段", entries.length, 9);
ok("块序列被当成一个条目（sources 含它的两行）", (() => {
	const e = entries.find((x) => x.key === "sources");
	return UPSTREAM.slice(e.start, e.end).includes("- wiki/sources/数分笔记-abc123.md");
})());

const fields = readFields(UPSTREAM);
eq("读行内数组 tags", JSON.stringify(fields.tags), JSON.stringify(["concept", "一致收敛", "函数项级数"]));
eq("读块序列 sources", JSON.stringify(fields.sources), JSON.stringify(["wiki/sources/数分笔记-abc123.md"]));
eq("读标量 status", fields.status, "draft");

// §10.2 证据表第 3 条：多行 YAML 数组要能正确读写
const mlFields = readFields(MULTILINE_TAGS);
eq("多行 YAML 数组能读出来", JSON.stringify(mlFields.tags), JSON.stringify(["数学分析", "极限"]));

/* ---------------- 2. 只改标签：正文与其余字段字节不变 ---------------- */

const afterTags = patchFrontmatter(UPSTREAM, { tags: ["concept", "一致收敛", "新标签"] });

eq("只改标签 → 正文字节完全不变", readBodyRaw(afterTags), readBodyRaw(UPSTREAM));
ok("只改标签 → 正文里的连续空行没被压掉", readBodyRaw(afterTags).includes("。\n\n\n上面"));
ok("只改标签 → 正文末尾的尾随空格没被 trim 掉", readBodyRaw(afterTags).endsWith("行尾有三个空格 →   \n\n\n"));

const beforeOther = parseEntries(UPSTREAM).filter((e) => e.key !== "tags").map((e) => UPSTREAM.slice(e.start, e.end));
const afterOther = parseEntries(afterTags).filter((e) => e.key !== "tags").map((e) => afterTags.slice(e.start, e.end));
eq("只改标签 → 其余 8 个 frontmatter 字段逐字节不变", JSON.stringify(afterOther), JSON.stringify(beforeOther));
ok("只改标签 → tags 仍是行内形态（没换成块序列）", /\ntags: \[concept, 一致收敛, 新标签\]\n/.test(afterTags));

/* ---------------- 3. 只改 status / confidence ---------------- */

const afterStatus = patchFrontmatter(UPSTREAM, { status: "reviewed", confidence: "high" });
eq("只改 status/confidence → 正文字节完全不变", readBodyRaw(afterStatus), readBodyRaw(UPSTREAM));
const beforeOther2 = parseEntries(UPSTREAM).filter((e) => !["status", "confidence"].includes(e.key)).map((e) => UPSTREAM.slice(e.start, e.end));
const afterOther2 = parseEntries(afterStatus).filter((e) => !["status", "confidence"].includes(e.key)).map((e) => afterStatus.slice(e.start, e.end));
eq("只改 status/confidence → 其余 7 个字段逐字节不变", JSON.stringify(afterOther2), JSON.stringify(beforeOther2));
eq("status 改对了", readFields(afterStatus).status, "reviewed");
eq("confidence 改对了", readFields(afterStatus).confidence, "high");

/* ---------------- 4. 多行数组保持形态 ---------------- */

const afterMl = patchFrontmatter(MULTILINE_TAGS, { tags: ["数学分析", "极限", "连续性"] });
ok("多行 YAML 数组写回后仍是块序列", /tags:\n  - 数学分析\n  - 极限\n  - 连续性\n/.test(afterMl));
eq("多行数组页 → 正文字节不变", readBodyRaw(afterMl), readBodyRaw(MULTILINE_TAGS));
eq("多行数组页 → 其余字段可读", readFields(afterMl).status, "draft");

/* ---------------- 5. YAML 转义（§10.2 证据表第 4 条） ---------------- */

eq("普通中文不加引号", yamlScalar("一致收敛"), "一致收敛");
eq("含冒号要加引号", yamlScalar("定理: 柯西"), '"定理: 柯西"');
eq("含井号要加引号", yamlScalar("C# 入门"), '"C# 入门"');
eq("含双引号要转义", yamlScalar('他说"对"'), '"他说\\"对\\""');
eq("看起来像布尔要加引号", yamlScalar("true"), '"true"');
eq("看起来像数字要加引号", yamlScalar("2026"), '"2026"');
// ISO 日期必须**不加**引号——上游写的就是不带引号的，加了就是一处格式漂移
eq("ISO 日期不加引号（与上游同形）", yamlScalar("2026-08-07"), "2026-08-07");
ok("改 updated 后与上游同形", /\nupdated: 2026-08-07\n/.test(patchFrontmatter(UPSTREAM, { updated: "2026-08-07" })));
eq("空串加引号", yamlScalar(""), '""');
eq("前后空白要加引号", yamlScalar(" x "), '" x "');

const tricky = patchFrontmatter(UPSTREAM, { title: "拉格朗日中值定理: 一个 #注记" });
ok("含 YAML 特殊字符的标题写回后仍可被解析回原值", readFields(tricky).title === "拉格朗日中值定理: 一个 #注记",
	`实际读回：${JSON.stringify(readFields(tricky).title)}`);

/* ---------------- 6. 字段不存在时追加 ---------------- */

const added = patchFrontmatter(MULTILINE_TAGS, { confidence: "low" });
eq("原本没有的字段被追加", readFields(added).confidence, "low");
eq("追加字段 → 正文字节不变", readBodyRaw(added), readBodyRaw(MULTILINE_TAGS));
ok("追加的字段在闭合 --- 之前", /confidence: low\n---\n/.test(added));

/* ---------------- 7. 正文整段替换：frontmatter 不动 ---------------- */

const newBody = "# 一致收敛\n\n改写过的正文。\n";
const replaced = replaceBody(UPSTREAM, newBody);
eq("整段替换正文后 frontmatter 逐字节不变",
	replaced.slice(0, locateFrontmatter(replaced).bodyStart),
	UPSTREAM.slice(0, locateFrontmatter(UPSTREAM).bodyStart));
eq("正文换成了新的", readBodyRaw(replaced), newBody);

/* ---------------- 8. 拒绝越权与拒绝乱猜 ---------------- */

let threw = false;
try { patchFrontmatter(UPSTREAM, { sources: ["x"] }); } catch { threw = true; }
ok("改非托管字段（sources）会抛错，不悄悄改", threw);

threw = false;
try { patchFrontmatter("没有 frontmatter 的裸文件\n", { tags: ["a"] }); } catch { threw = true; }
ok("没有 frontmatter 的文件拒绝改写，不去猜", threw);

eq("托管字段表就是这 6 个", MANAGED_KEYS.join(","), "tags,status,confidence,contested,updated,title");

/* ---------------- 9. 幂等 ---------------- */

const once = patchFrontmatter(UPSTREAM, { tags: ["a", "b"] });
const twice = patchFrontmatter(once, { tags: ["a", "b"] });
eq("同样的 patch 跑两次，第二次一个字节都不变", twice, once);

/* ---------------- 结果 ---------------- */

console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) {
	console.log("  失败项：");
	for (const f of failures) console.log(`    · ${f}`);
	console.log("");
	process.exit(1);
}
