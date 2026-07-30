// 最小闭环原型：读真实 wiki md → 渲染 → 结构化改 tag / 关联 → 写回 md
// 核心零依赖，只用 Node 内置模块。不连数据库、不做发布语义。
// 唯一的例外是 POST /api/polish：它惰性导入 polish-agent.mjs 唤起隔离子代理，
// 没装依赖 / 没配模型时如实报错，其余功能不受影响（ADR-V2-022）。
//
// 分区所有权（ADR-V2-021）在这里落地为最小可验证形式：
//   系统托管区 = frontmatter 的 tags 字段 + 正文里 `## 相关知识` 这一段
//   用户自由区 = 其余全部内容，读写全程原样保留，一个字节都不碰

import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateFacts } from "./citation.mjs";
import { ingestSource, listSources, readSource, verifySource } from "./source-store.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * 读哪个 wiki 目录。按顺序，先找到先用：
 *
 *   1. INNO_WIKI_DIR                              显式指定
 *   2. $INNO_AGENT_DIR/runtime/data/l2/wiki       InnoSpark 的真实 L2（推荐）
 *   3. ./data/wiki                                自带的沙盒样例，改坏了不心疼
 *
 * 第 2 条才是这个插件的正经用法——它要编辑的就是 InnoSpark 那份真实知识库。
 * 第 3 条只是没装 InnoSpark 时也能打开看看，不要拿它当产品形态。
 */
function resolveWikiDir() {
	if (process.env.INNO_WIKI_DIR) {
		return { dir: process.env.INNO_WIKI_DIR, from: "环境变量 INNO_WIKI_DIR", live: true };
	}
	if (process.env.INNO_AGENT_DIR) {
		return {
			dir: join(process.env.INNO_AGENT_DIR, "runtime", "data", "l2", "wiki"),
			from: "InnoSpark 的真实 L2 知识库",
			live: true,
		};
	}
	// data/wiki 是本地开发用的沙盒（不进仓库）；sample/wiki 是仓库自带的中性样例
	if (existsSync(join(ROOT, "data", "wiki"))) {
		return { dir: join(ROOT, "data", "wiki"), from: "本地沙盒数据", live: false };
	}
	return { dir: join(ROOT, "sample", "wiki"), from: "仓库自带的示例数据", live: false };
}

const WIKI_SRC = resolveWikiDir();
const WIKI = WIKI_SRC.dir;
const SOURCES = process.env.INNO_SOURCES_DIR ?? join(ROOT, "data", "sources");

// 设置面板里选的模型。只在进程内生效——重启回到配置文件的默认值。
// 刻意不落盘：这是个调试期的开关，不该悄悄改掉用户 InnoSpark 的配置
let MODEL_PICK = null;
const PORT = 4321;
const MANAGED_HEADING = "## 相关知识";
const PAGE_DIRS = ["sources", "concepts", "entities", "analysis"];

/* ---------------- Markdown 文件读写 ---------------- */

function splitFrontmatter(raw) {
	if (!raw.startsWith("---")) return { fmLines: [], body: raw };
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { fmLines: [], body: raw };
	const fm = raw.slice(raw.indexOf("\n") + 1, end);
	const body = raw.slice(end + 4).replace(/^\n/, "");
	return { fmLines: fm.split("\n"), body };
}

// 只结构化解析我们要管的字段，其余整行原样留着
function readField(fmLines, key) {
	const line = fmLines.find((l) => l.startsWith(`${key}:`));
	if (!line) return null;
	return line.slice(key.length + 1).trim();
}

function parseInlineArray(value) {
	if (!value || !value.startsWith("[")) return [];
	return value
		.slice(1, value.lastIndexOf("]"))
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/* ---- 链接解析：移植上游 wiki-links.ts 的口径，两边不能各写一套 ---- */

// 去别名部分、小写、全角转半角、全角空格、压缩空白
function normalizeWikiLink(s) {
	return s
		.split("|")[0]
		.trim()
		.toLowerCase()
		.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
		.replace(/　/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// 去掉结尾的一层括号后缀：`GRPO（Group…）` → `GRPO`
function stripParenthetical(s) {
	return s.replace(/[（(][^（()）]*[)）]\s*$/, "").trim();
}

function pageStem(p) {
	return (p.split("/").pop() ?? p).replace(/\.md$/, "");
}

// 抽取整页正文里的全部 [[链接]]，不限于某一段
function extractOutgoingLinks(body) {
	return [...body.matchAll(/\[\[([^\]]+)\]\]/g)]
		.map((m) => m[1].split("|")[0].trim())
		.filter(Boolean);
}

// 别名索引：标题 / 文件名 stem / 路径为主键，去括号形式为次键；
// 两页归一到同一次键时记为歧义（null），宁可不连也不错连
function buildAliasIndex(pages) {
	const primary = new Map();
	const base = new Map();
	const addBase = (key, path) => {
		if (!key) return;
		if (base.has(key)) {
			if (base.get(key) !== path) base.set(key, null);
		} else base.set(key, path);
	};
	for (const p of pages) {
		const nTitle = normalizeWikiLink(p.title);
		if (nTitle) primary.set(nTitle, p.path);
		const nStem = normalizeWikiLink(pageStem(p.path));
		if (nStem && !primary.has(nStem)) primary.set(nStem, p.path);
		primary.set(p.path.toLowerCase(), p.path);
		addBase(normalizeWikiLink(stripParenthetical(p.title)), p.path);
	}
	return (link) => {
		const n = normalizeWikiLink(link);
		if (primary.has(n)) return primary.get(n);
		const lb = normalizeWikiLink(stripParenthetical(link));
		if (lb !== n && primary.has(lb)) return primary.get(lb);
		return base.get(n) ?? base.get(lb) ?? null;
	};
}

function parseManagedBlock(body) {
	const idx = body.indexOf(MANAGED_HEADING);
	if (idx === -1) return { links: [], free: body };
	const after = body.slice(idx + MANAGED_HEADING.length);
	const nextHeading = after.search(/\n##\s/);
	const block = nextHeading === -1 ? after : after.slice(0, nextHeading);
	const rest = nextHeading === -1 ? "" : after.slice(nextHeading);
	const links = [...block.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
	return { links, free: (body.slice(0, idx) + rest).replace(/\n{3,}/g, "\n\n") };
}

function buildFile(fmLines, freeBody, tags, links, titleToPath) {
	const today = new Date().toISOString().slice(0, 10);
	const out = fmLines.map((line) => {
		if (line.startsWith("tags:")) return `tags: [${tags.join(", ")}]`;
		if (line.startsWith("updated:")) return `updated: ${today}`;
		return line;
	});
	if (!out.some((l) => l.startsWith("tags:"))) out.push(`tags: [${tags.join(", ")}]`);
	if (!out.some((l) => l.startsWith("updated:"))) out.push(`updated: ${today}`);

	let body = freeBody.trimEnd();
	if (links.length > 0) {
		const lines = links.map((t) => {
			const p = titleToPath.get(t);
			return p ? `- [[${t}]] — \`${p}\`` : `- [[${t}]]`;
		});
		body += `\n\n${MANAGED_HEADING}\n\n${lines.join("\n")}\n`;
	} else {
		body += "\n";
	}
	return `---\n${out.join("\n")}\n---\n${body}`;
}

/* ---------------- 目录扫描 ---------------- */

async function listPages() {
	const pages = [];
	for (const dir of PAGE_DIRS) {
		let entries;
		try {
			entries = await readdir(join(WIKI, dir));
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".md")) continue;
			const rel = ["wiki", dir, name].join("/");
			const raw = await readFile(join(WIKI, dir, name), "utf8");
			const { fmLines } = splitFrontmatter(raw);
			pages.push({
				path: rel,
				title: readField(fmLines, "title") ?? name.replace(/\.md$/, ""),
				type: readField(fmLines, "type") ?? dir,
				tags: parseInlineArray(readField(fmLines, "tags")),
			});
		}
	}
	return pages.sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

async function buildCatalog() {
	const pages = await listPages();
	const counts = new Map();
	for (const p of pages) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
	const tags = [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
	return { pages, tags };
}

function safePath(rel) {
	if (typeof rel !== "string" || !rel.startsWith("wiki/")) return null;
	const abs = join(WIKI, rel.slice("wiki/".length));
	const inside = relative(WIKI, abs);
	if (inside.startsWith("..") || inside.startsWith(sep) || inside.includes("..")) return null;
	if (!abs.endsWith(".md")) return null;
	return abs;
}

/* ---------------- HTTP ---------------- */

function json(res, code, data) {
	const body = JSON.stringify(data);
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * 只放行本机的 InnoSpark。
 *
 * 寄存区在 InnoSpark 页面里（:3000），要往这边 POST，跨源必须放行。
 * 但只放行**本机固定几个来源**，不写 `*`：这个服务能读写你的知识库，
 * 让任意网页都能 POST 过来是不可接受的。
 */
const ALLOWED_ORIGINS = new Set(
	(process.env.INNO_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173")
		.split(",").map((s) => s.trim()).filter(Boolean),
);

function applyCors(req, res) {
	const origin = req.headers.origin;
	if (origin && ALLOWED_ORIGINS.has(origin)) {
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("vary", "origin");
		res.setHeader("access-control-allow-headers", "content-type");
		res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	applyCors(req, res);

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		return res.end();
	}

	try {
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			const html = await readFile(join(ROOT, "index.html"), "utf8");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return res.end(html);
		}

		if (req.method === "GET" && url.pathname === "/api/catalog") {
			const cat = await buildCatalog();
			// 界面要如实显示「你正在编辑哪一份知识库」——沙盒和真实库不能长一样
			return json(res, 200, { ...cat, wiki: { dir: WIKI, from: WIKI_SRC.from, live: WIKI_SRC.live } });
		}

		if (req.method === "GET" && url.pathname === "/api/graph") {
			const all = (await buildCatalog()).pages;
			// overview 是从全库汇总出来的元页面，进图会变成「连接一切」的超级节点，
			// 并且反过来抬高它自己排出来的那些节点的度数——上游同样把它排除
			const pages = all.filter((p) => p.path !== "wiki/analysis/overview.md");
			const resolve = buildAliasIndex(pages);
			const known = new Set(pages.map((p) => p.path));

			const nodes = pages.map((p) => ({ id: p.path, title: p.title, type: p.type }));
			const edges = [];
			const seen = new Set();
			const phantom = new Set();
			const tagSeen = new Set();
			const missing = [];

			const addEdge = (a, b, type) => {
				const key = [a, b].sort().join("|") + "|" + type;
				if (seen.has(key)) return;
				seen.add(key);
				edges.push({ a, b, type });
			};

			for (const p of pages) {
				const raw = await readFile(safePath(p.path), "utf8");
				const { body } = splitFrontmatter(raw);
				for (const rawLink of extractOutgoingLinks(body)) {
					const target = resolve(rawLink);
					if (target && known.has(target)) {
						if (target !== p.path) addEdge(p.path, target, "link");
					} else {
						// 未解析：建一个幻影节点，如实显示「这一页还不存在」
						const id = `missing:${normalizeWikiLink(rawLink)}`;
						if (!phantom.has(id)) {
							phantom.add(id);
							nodes.push({ id, title: rawLink, type: "missing" });
						}
						addEdge(p.path, id, "link");
						missing.push({ from: p.path, link: rawLink });
					}
				}
				// 标签本身也是节点：共享标签的页面因此连成一片
				for (const tag of p.tags) {
					const id = `tag:${tag}`;
					if (!tagSeen.has(id)) {
						tagSeen.add(id);
						nodes.push({ id, title: `#${tag}`, type: "tag" });
					}
					addEdge(p.path, id, "tag");
				}
			}

			return json(res, 200, { nodes, edges, missing });
		}

		if (req.method === "GET" && url.pathname === "/api/page") {
			const abs = safePath(url.searchParams.get("path"));
			if (!abs) return json(res, 400, { error: "非法路径" });
			const raw = await readFile(abs, "utf8");
			const { fmLines, body } = splitFrontmatter(raw);
			const { links, free } = parseManagedBlock(body);
			const st = await stat(abs);

			// 正文自由区里手写的 [[链接]] 同样算正式关联（用户裁定），
			// 但它的载体是正文，因此只读回报，不在面板里直接删
			const all = (await buildCatalog()).pages;
			const resolve = buildAliasIndex(all);
			const byPath = new Map(all.map((p) => [p.path, p]));
			const bodyLinks = [];
			const seenBody = new Set();
			for (const rawLink of extractOutgoingLinks(free)) {
				const target = resolve(rawLink);
				const title = target ? (byPath.get(target)?.title ?? rawLink) : rawLink;
				if (target === url.searchParams.get("path")) continue;
				if (seenBody.has(title)) continue;
				seenBody.add(title);
				bodyLinks.push({ raw: rawLink, title, path: target, resolved: Boolean(target) });
			}

			return json(res, 200, {
				path: url.searchParams.get("path"),
				title: readField(fmLines, "title") ?? "",
				type: readField(fmLines, "type") ?? "",
				updated: readField(fmLines, "updated") ?? "",
				status: readField(fmLines, "status") ?? "",
				tags: parseInlineArray(readField(fmLines, "tags")),
				links,
				bodyLinks,
				body: free,
				mtimeMs: st.mtimeMs,
			});
		}

		if (req.method === "PUT" && url.pathname === "/api/page") {
			const payload = await readBody(req);
			const abs = safePath(payload.path);
			if (!abs) return json(res, 400, { error: "非法路径" });

			// 以文件为准：写回前重读磁盘。用户在界面里改过正文时以界面为准，
			// 否则取磁盘上的最新内容（用户可能刚在 Obsidian 里手改过）
			const raw = await readFile(abs, "utf8");
			const { fmLines, body } = splitFrontmatter(raw);
			const onDisk = parseManagedBlock(body);
			const free = typeof payload.body === "string" ? payload.body : onDisk.free;

			const { pages } = await buildCatalog();
			const titleToPath = new Map(pages.map((p) => [p.title, p.path]));

			const tags = [...new Set((payload.tags ?? []).map((s) => String(s).trim()).filter(Boolean))];
			const links = [...new Set((payload.links ?? []).map((s) => String(s).trim()).filter(Boolean))];

			await writeFile(abs, buildFile(fmLines, free, tags, links, titleToPath), "utf8");

			// 双向关联：对端也要出现这一条（D-02 的最小形态）
			const applied = [];
			const self = pages.find((p) => p.path === payload.path);
			if (self) {
				for (const target of links) {
					const t = pages.find((p) => p.title === target);
					if (!t) continue;
					const tAbs = safePath(t.path);
					if (!tAbs) continue;
					const tRaw = await readFile(tAbs, "utf8");
					const tParts = splitFrontmatter(tRaw);
					const tBlock = parseManagedBlock(tParts.body);
					if (tBlock.links.includes(self.title)) continue;
					const tTags = parseInlineArray(readField(tParts.fmLines, "tags"));
					await writeFile(
						tAbs,
						buildFile(tParts.fmLines, tBlock.free, tTags, [...tBlock.links, self.title], titleToPath),
						"utf8",
					);
					applied.push(t.title);
				}
			}

			return json(res, 200, { ok: true, reverseSynced: applied });
		}

		// 模型是否可用 + 配置从哪来 + 有哪些模型可选。
		// 只读配置，不建会话、不调模型，所以问它是免费的。**绝不回传 apiKey**
		if (req.method === "GET" && url.pathname === "/api/polish/status") {
			try {
				const { loadModelConfig, describeModelConfig } = await import("./polish-agent.mjs");
				const cfg = await loadModelConfig(ROOT, MODEL_PICK);
				const desc = await describeModelConfig(ROOT).catch(() => null);
				return json(res, 200, {
					ready: true,
					providerId: cfg.providerId,
					modelId: cfg.modelId,
					configPath: cfg.configPath,
					configFrom: cfg.configFrom,
					keyFrom: cfg.keyFrom,
					picked: MODEL_PICK,
					providers: desc?.providers ?? [],
					defaults: desc ? { providerId: desc.defaultProvider, modelId: desc.defaultModel } : null,
				});
			} catch (err) {
				const desc = await import("./polish-agent.mjs")
					.then((m) => m.describeModelConfig(ROOT))
					.catch(() => null);
				return json(res, 200, {
					ready: false,
					reason: err?.reason ?? "unavailable",
					error: String(err?.message ?? err),
					configPath: desc?.configPath ?? null,
					configFrom: desc?.configFrom ?? null,
					providers: desc?.providers ?? [],
				});
			}
		}

		// 选用哪个模型。只在配置已有的模型里挑，进程内生效，不写任何文件
		if (req.method === "POST" && url.pathname === "/api/polish/model") {
			const payload = await readBody(req);
			if (payload.reset) {
				MODEL_PICK = null;
				return json(res, 200, { ok: true, picked: null });
			}
			try {
				const { loadModelConfig } = await import("./polish-agent.mjs");
				const pick = { providerId: payload.providerId, modelId: payload.modelId };
				const cfg = await loadModelConfig(ROOT, pick);   // 选不中就会抛，抛了就不生效
				MODEL_PICK = { providerId: cfg.providerId, modelId: cfg.modelId };
				return json(res, 200, { ok: true, picked: MODEL_PICK });
			} catch (err) {
				return json(res, 400, { ok: false, error: String(err?.message ?? err) });
			}
		}

		// 唤起润色子代理。注意这里只返回「建议」，一个字都不写进文件——
		// 落不落进正文由用户在界面上决定（S-B 完成定义）
		if (req.method === "POST" && url.pathname === "/api/polish") {
			const payload = await readBody(req);
			try {
				const { polish } = await import("./polish-agent.mjs");
				const out = await polish({
					root: ROOT,
					text: payload.text,
					instruction: payload.instruction,
					pick: MODEL_PICK,
				});
				return json(res, 200, { ok: true, ...out });
			} catch (err) {
				// 未配置不是服务器故障，是一个如实的「这个能力现在不可用」
				const reason = err?.reason ?? "unavailable";
				return json(res, reason === "unconfigured" ? 501 : 502, {
					ok: false,
					reason,
					error: String(err?.message ?? err),
				});
			}
		}

		/* ---------------- S-C 最小版：冻结来源 → 草稿 → 审阅 → 落盘 ---------------- */

		// 已冻结的来源清单。每条都现场重算 hash 对账，intact:false 就是原件被动过
		if (req.method === "GET" && url.pathname === "/api/sources") {
			const metas = await listSources(SOURCES);
			const items = [];
			for (const m of metas) {
				const v = await verifySource(SOURCES, m.sourceId).catch(() => ({ intact: false }));
				items.push({ ...m, intact: v.intact });
			}
			return json(res, 200, { sources: items });
		}

		// 摄入并冻结。内容寻址，同一份内容重复摄入是幂等的。
		// 接受一段 text，或多段 segments（把 AI 的几轮回答攒成一份资料）
		if (req.method === "POST" && url.pathname === "/api/sources") {
			const payload = await readBody(req);
			const hasSegments = Array.isArray(payload.segments) &&
				payload.segments.some((s) => typeof s === "string" && s.trim());
			const hasText = typeof payload.text === "string" && payload.text.trim();
			if (!hasSegments && !hasText) return json(res, 400, { error: "来源是空的" });
			try {
				const { meta, alreadyFrozen } = await ingestSource(SOURCES, {
					filename: payload.filename,
					title: payload.title,
					text: payload.text,
					segments: payload.segments,
				});
				return json(res, 200, { ok: true, source: meta, alreadyFrozen });
			} catch (err) {
				return json(res, 400, { error: String(err?.message ?? err) });
			}
		}

		// 编译草稿。模型产出**立刻**逐条过引文校验，对不上的标 blocked 带回来，
		// 既不悄悄丢掉、也不放行（红线 2 + 红线 3）
		if (req.method === "POST" && url.pathname === "/api/compile") {
			const payload = await readBody(req);
			let source;
			try {
				source = await readSource(SOURCES, String(payload.sourceId ?? ""));
			} catch {
				return json(res, 400, { error: "找不到这份来源" });
			}
			const check = await verifySource(SOURCES, payload.sourceId);
			if (!check.intact) {
				// 原件被改过，引文校验就失去意义了，直接拒绝编译
				return json(res, 409, {
					ok: false,
					reason: "source_tampered",
					error: "这份来源的内容和摄入时对不上，已拒绝编译",
					check,
				});
			}
			try {
				const { compileConcept } = await import("./polish-agent.mjs");
				const out = await compileConcept({
					root: ROOT,
					sourceText: source.text,
					topic: payload.topic,
					instruction: payload.instruction,
					pick: MODEL_PICK,
				});
				const facts = validateFacts(out.draft.facts, source.text);
				return json(res, 200, {
					ok: true,
					draft: { ...out.draft, facts },
					source: source.meta,
					model: out.model,
					isolation: out.isolation,
					stats: {
						total: facts.length,
						verified: facts.filter((f) => f.verified).length,
						blocked: facts.filter((f) => !f.verified).length,
					},
				});
			} catch (err) {
				const reason = err?.reason ?? "unavailable";
				return json(res, reason === "unconfigured" ? 501 : 502, {
					ok: false,
					reason,
					error: String(err?.message ?? err),
				});
			}
		}

		// 落盘。到这一步才第一次写文件——而且只写用户勾选、且通过校验的那些条目
		if (req.method === "POST" && url.pathname === "/api/page/create") {
			const payload = await readBody(req);
			const title = String(payload.title ?? "").trim();
			if (!title) return json(res, 400, { error: "标题不能为空" });
			if (/[\\/:*?"<>|]/.test(title)) return json(res, 400, { error: "标题里有不能做文件名的字符" });

			let source;
			try {
				source = await readSource(SOURCES, String(payload.sourceId ?? ""));
			} catch {
				return json(res, 400, { error: "找不到这份来源" });
			}

			// 先查冻结，再查引文——顺序不能反。
			// 引文校验只能保证「和文件一致」；只有冻结对账才能保证「文件和摄入时一致」。
			// 少了这一步，改一改 raw.md 就能让任何编造的句子通过校验。
			const intact = await verifySource(SOURCES, payload.sourceId);
			if (!intact.intact) {
				return json(res, 409, {
					ok: false,
					reason: "source_tampered",
					error: "这份来源的内容和摄入时对不上，已拒绝写入",
					check: intact,
				});
			}

			// 服务端重新校验一遍。界面上的勾选状态不可信——
			// 校验必须在写盘这一侧再做一次，否则红线 2 只是一句界面文案
			const facts = validateFacts(payload.facts ?? [], source.text);
			const rejected = facts.filter((f) => !f.verified);
			if (rejected.length > 0) {
				return json(res, 422, {
					ok: false,
					reason: "citation_failed",
					error: `有 ${rejected.length} 条引文核不上，已拒绝写入`,
					facts: rejected,
				});
			}

			const rel = `wiki/concepts/${title}.md`;
			const abs = safePath(rel);
			if (!abs) return json(res, 400, { error: "非法路径" });
			try {
				await stat(abs);
				return json(res, 409, { ok: false, reason: "exists", error: `已经有一页叫「${title}」了` });
			} catch { /* 不存在，正是我们要的 */ }
			// 全新装的 InnoSpark 里 wiki/ 连目录都还没有——第一次建页要先把它创出来
			await mkdir(dirname(abs), { recursive: true });

			const today = new Date().toISOString().slice(0, 10);
			const tags = [...new Set(["concept", ...(payload.tags ?? []).map((s) => String(s).trim())])].filter(Boolean);
			const body = [
				`# ${title}`,
				"",
				"## 定义",
				"",
				String(payload.summary ?? "").trim(),
				"",
				"## 要点",
				"",
				...facts.map((f) => `- ${f.text}`),
			];
			const links = [...new Set((payload.links ?? []).map((s) => String(s).trim()).filter(Boolean))];
			if (links.length) body.push("", "## 相关知识", "", ...links.map((l) => `- [[${l}]]`));

			const fm = [
				`title: ${title}`,
				`created: ${today}`,
				"type: concept",
				`tags: [${tags.join(", ")}]`,
				"sources:",
				`  - ${source.meta.filename}`,
				"source_ids:",
				`  - ${source.meta.sourceId}`,
				`updated: ${today}`,
				"status: draft",
				"confidence: medium",
			];
			await writeFile(abs, `---\n${fm.join("\n")}\n---\n${body.join("\n")}\n`, "utf8");
			return json(res, 200, { ok: true, path: rel, facts: facts.length });
		}

		json(res, 404, { error: "not found" });
	} catch (err) {
		json(res, 500, { error: String(err && err.message ? err.message : err) });
	}
});

server.listen(PORT, () => {
	console.log(`L2 结构化编辑  http://localhost:${PORT}`);
	console.log(`知识库         ${WIKI}`);
	console.log(`               （${WIKI_SRC.from}）`);
	if (!WIKI_SRC.live) {
		console.log("");
		console.log("提示：现在编辑的是自带样例，不是 InnoSpark 的真实知识库。");
		console.log("      要接真实的，设 INNO_AGENT_DIR 指向 InnoSpark 安装目录。");
	}
	console.log(`来源冻结区     ${SOURCES}`);
});
