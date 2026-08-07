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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateFacts } from "./citation.mjs";
import { ingestSource, listSources, readSource, verifySource } from "./source-store.mjs";
import { patchFrontmatter, readBodyRaw, readFields, replaceBody } from "./frontmatter.mjs";

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
// 删除前的回收站副本落在这里（执行决议 D-03）。
// 刻意放在**插件自己的** data/ 下、而不是上游 l2/ 里：上游 rebuildIndex 是扫盘的
// （wiki-maintainer.ts:418），副本只要落在它的扫描范围内就会被当成正常页收回索引。
const TRASH = process.env.INNO_TRASH_DIR ?? join(ROOT, "data", ".trash");

/**
 * 上游 InnoSpark 的地址。**所有写入都从这里走。**
 *
 * 为什么写入不能由插件自己落盘（设计文档 §4 + 人类裁定 2026-08-07）：
 * 磁盘上的 `l2/` 有多个写入方（上游 agent 的 `l2_archive`、上游 Notebook、本插件），
 * 而唯一关得死的乐观锁必须让"读盘比对 + 写入"发生在**同一个进程的同一次请求里**。
 * 插件自己"先 GET 算 hash → 比对 → 再写"只是把窗口从几分钟缩到几十毫秒，没关死；
 * 一条关不死的护栏被叫做乐观锁，就是红线 3。
 *
 * 上游没在跑时**如实报错**，不降级偷偷直写文件。
 */
const UPSTREAM = (process.env.INNO_UPSTREAM ?? "http://localhost:3000").replace(/\/+$/, "");

/** 整个文件**原始字节**的 sha256。口径必须和上游 `PUT /api/l2/page` 那边一致。 */
function revisionOf(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/**
 * 调上游。连不上时抛一个带 `reason` 的错，由调用方翻译成如实的界面文案。
 * 绝不 catch 之后自己写盘——那正是 §4 说的"降级偷偷直写"。
 */
async function callUpstream(method, path, body) {
	let resp;
	try {
		resp = await fetch(`${UPSTREAM}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(300_000),
		});
	} catch (err) {
		const e = new Error(`连不上 InnoSpark（${UPSTREAM}）：${err?.message ?? err}`);
		e.reason = "upstream_down";
		throw e;
	}
	let data = null;
	try {
		data = await resp.json();
	} catch { /* 上游可能返回空体 */ }
	return { status: resp.status, data };
}

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

/**
 * 合成正文 = 用户自由区 + `## 相关知识` 那一段。
 *
 * 只有在**关联或正文真的被改了**的时候才调它——正文是整段替换的
 * （§10.2 的 2026-08-05 修订：正文不再做区间 patch，与上游 Notebook 的 MDEditor 同语义）。
 * 只改标签 / status 的时候不碰正文，那条路径走 `patchFrontmatter`，正文字节不变。
 *
 * 注意这里**不**再 trimEnd、**不**再压连续换行——那正是 §10.2 要修掉的两条。
 */
function composeBody(freeBody, links, titleToPath) {
	if (links.length === 0) return freeBody;
	const lines = links.map((t) => {
		const p = titleToPath.get(t);
		return p ? `- [[${t}]] — \`${p}\`` : `- [[${t}]]`;
	});
	return `${freeBody.replace(/\s*$/, "")}\n\n${MANAGED_HEADING}\n\n${lines.join("\n")}\n`;
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

/**
 * 谁链向这一页（U-F①，设计文档 §6 的第一项）。
 *
 * **查询得出，不是存出来的。** 这一条从"后移的增强"变成了当前批次的必需品：
 * §11 取消了双向落盘（正文 wikilink 只写发起的那一边），
 * 没有反向链接的话，用户打开 B 页就看不到 A —— 取消双向存储等于让关联消失一半。
 *
 * 口径和 `/api/graph` 完全一致：同一套 `resolve`（移植上游 wiki-links.ts 的归一化），
 * 扫每一页的出链，筛出指向目标的那些。两处不能各写一套。
 *
 * 不含 `excerpt`（链接出现在哪一句）——那要额外记链接的字符偏移，属后移部分（§6）。
 */
async function computeBacklinks(targetPath, pages, resolve) {
	if (!targetPath) return [];
	const out = [];
	for (const p of pages) {
		if (p.path === targetPath) continue;
		const abs = safePath(p.path);
		if (!abs) continue;
		const { body } = splitFrontmatter(await readFile(abs, "utf8"));
		for (const rawLink of extractOutgoingLinks(body)) {
			if (resolve(rawLink) === targetPath) {
				out.push({ path: p.path, title: p.title, type: p.type });
				break; // 一页只报一次，不管它链了几次
			}
		}
	}
	return out.sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

function safePath(rel) {
	if (typeof rel !== "string" || !rel.startsWith("wiki/")) return null;
	const abs = join(WIKI, rel.slice("wiki/".length));
	const inside = relative(WIKI, abs);
	if (inside.startsWith("..") || inside.startsWith(sep) || inside.includes("..")) return null;
	if (!abs.endsWith(".md")) return null;
	return abs;
}

/* ---------------- 后台归档任务 ---------------- */

// 只在内存里。任务是编辑期的一次动作，不是需要持久化的状态；
// 进程重启后未完成的任务本来也接不回去，假装能接回去比丢掉更糟。
const TASKS = new Map();

/**
 * 插件的 `src_<12位hash>` ↔ 上游 manifest 的 `l2src_<8位随机>` 的映射。
 *
 * 存在**插件自己**的 meta.json 里，不往上游的数据结构里塞字段（§4）：
 * 上游的 `ManifestEntry` 是它的契约，我们加字段就等于又制造了一处需要跟随的格式。
 */
async function recordSourceMapping(pluginSourceId, upstreamId, wikiPagePath) {
	const file = join(SOURCES, "meta.json");
	let meta = {};
	try {
		meta = JSON.parse(await readFile(file, "utf8"));
	} catch { /* 还没有就从空的开始 */ }
	meta[pluginSourceId] = {
		upstreamId,
		wikiPagePath,
		archivedAt: new Date().toISOString(),
	};
	await mkdir(SOURCES, { recursive: true });
	await writeFile(file, `${JSON.stringify(meta, null, "\t")}\n`, "utf8");
}

/**
 * 归档 = 两步，顺序不能反。
 *
 *   ① POST /api/l2/archive        把**冻结来源原文**归档成一份资料
 *                                 （五个副作用由它全包：manifest / index.md /
 *                                  BM25 / overview / log.md）
 *   ② POST /api/l2/page/concept   把**用户逐条核对过的正文**落成 concept / entity 页
 *
 * 为什么要分两步（执行决议 D-10，实测发现）：
 * `l2_archive` 内部会对传进去的 content 再跑一次 `summarizeContent`，
 * 落盘的是**模型重写的版本**。要是把用户批准的草稿直接喂给它，
 * 用户逐条勾选核对过的那一份就只会进 raw/，永远上不了页面——
 * 引文闸门守住的东西在最后一米又被一个没有引文校验的模型改了一遍。
 *
 * 所以 ① 喂的是**原始资料**（它本来就该归档这个），② 才写用户批准的正文。
 */
function startArchiveTask({ title, type, tags, body, source, factCount }) {
	const id = `task_${createHash("sha256").update(`${title}${Date.now()}`).digest("hex").slice(0, 10)}`;
	const task = {
		id,
		state: "running",
		step: "归档资料到 InnoSpark…",
		title,
		startedAt: new Date().toISOString(),
	};
	TASKS.set(id, task);

	(async () => {
		// ① 归档冻结来源的原文
		const archived = await callUpstream("POST", "/api/l2/archive", {
			title: source.meta.title || source.meta.filename || title,
			content: source.text,
			sourceType: "markdown",
			tags,
			origin: "conversation",
		});
		if (archived.status !== 200) {
			throw Object.assign(new Error(archived.data?.error ?? `上游返回 ${archived.status}`), {
				detail: archived.data?.detail,
			});
		}
		const upstreamId = archived.data?.details?.id ?? "";
		const sourcePagePath = archived.data?.details?.wikiPagePath ?? "";

		// ② 把用户批准的正文落成页面
		task.step = "写入你核对过的内容…";
		const page = await callUpstream("POST", "/api/l2/page/concept", {
			title,
			type,
			body,
			tags,
			sourceId: upstreamId,
			sourcePagePath,
			// 人类裁定（2026-08-07）：撞名时用用户批准的版本覆盖。
			// l2_archive 的 maintainLinkedWikiPages 十有八九已经建了同名页。
			overwrite: true,
		});
		if (page.status !== 200) {
			throw new Error(page.data?.error ?? `上游返回 ${page.status}`);
		}

		await recordSourceMapping(source.meta.sourceId, upstreamId, page.data.path);
		return { path: page.data.path, upstreamId, sourcePagePath, overwritten: page.data.overwritten };
	})().then(
		(result) => {
			Object.assign(task, {
				state: "done",
				step: "",
				result: { ...result, facts: factCount },
				finishedAt: new Date().toISOString(),
			});
		},
		(err) => {
			// 失败要给出**可读的原因**，不吞（§4 完成定义）
			Object.assign(task, {
				state: "failed",
				step: "",
				reason: err?.reason ?? "upstream_error",
				error: err?.reason === "upstream_down"
					? `归档不可用：${err.message}`
					: String(err?.message ?? err),
				detail: err?.detail,
				finishedAt: new Date().toISOString(),
			});
		},
	);

	return task;
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
			const bytes = await readFile(abs);
			const raw = bytes.toString("utf8");
			const { fmLines, body } = splitFrontmatter(raw);
			const { links, free } = parseManagedBlock(body);
			const fields = readFields(raw);

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

			// 被谁引用（U-F①）。数据来自和 /api/graph 同一份边集合，
			// **是算出来的，不是 B 页正文里存的**——正文 wikilink 只存一次（§11）。
			// 标明只读：它是别的页写的，不该在这里改（ADR-V2-021 的分区所有权）。
			const backlinks = await computeBacklinks(url.searchParams.get("path"), all, resolve);

			return json(res, 200, {
				path: url.searchParams.get("path"),
				title: fields.title ?? "",
				type: fields.type ?? "",
				updated: fields.updated ?? "",
				status: fields.status ?? "",
				confidence: fields.confidence ?? "",
				tags: Array.isArray(fields.tags) ? fields.tags : [],
				links,
				bodyLinks,
				backlinks,
				body: free,
				// 乐观锁的凭据（§10.1）。哈希的是**整个文件**，不只是正文——
				// l2_archive 改的恰恰是 frontmatter（source_ids / updated / contested），
				// 只哈希正文这条护栏就漏了一半。
				revisionHash: revisionOf(bytes),
			});
		}

		// 保存。三件事在这里同时落地：
		//   U-J-1 乐观锁     —— 必须带 baseRevision，比对与写入在上游同一次请求里做完
		//   U-J-2 区间写回   —— 只 patch 托管字段那几段字节，其余原样搬运
		//   U-K  单边存储    —— **不再写对端**。在 A 页加关联只写 A 这一个文件
		if (req.method === "PUT" && url.pathname === "/api/page") {
			const payload = await readBody(req);
			const abs = safePath(payload.path);
			if (!abs) return json(res, 400, { error: "非法路径" });

			const baseRevision = typeof payload.baseRevision === "string" ? payload.baseRevision : "";
			if (!baseRevision) {
				// 不给"不带就直接覆盖"的后门——那样这条护栏可以被绕过，就不是锁了
				return json(res, 400, { error: "缺少 baseRevision，拒绝无版本写入" });
			}

			const bytes = await readFile(abs);
			const raw = bytes.toString("utf8");

			// 本地先比一次。这一比**不是**锁——真正的锁在上游那一次请求里；
			// 这里只是为了在明显过期时早点把差异摆给用户，省一次往返。
			if (revisionOf(bytes) !== baseRevision) {
				return json(res, 409, {
					ok: false,
					reason: "stale",
					error: "这一页在你编辑期间被改过了",
					revisionHash: revisionOf(bytes),
					content: raw,
				});
			}

			const { pages } = await buildCatalog();
			const titleToPath = new Map(pages.map((p) => [p.title, p.path]));

			/* ---- 1. frontmatter：只动托管字段的字节区间 ---- */
			const updates = { updated: new Date().toISOString().slice(0, 10) };
			if (Array.isArray(payload.tags)) {
				updates.tags = [...new Set(payload.tags.map((s) => String(s).trim()).filter(Boolean))];
			}
			for (const key of ["status", "confidence"]) {
				if (typeof payload[key] === "string" && payload[key]) updates[key] = payload[key];
			}
			let next;
			try {
				next = patchFrontmatter(raw, updates);
			} catch (err) {
				return json(res, 422, { ok: false, error: String(err?.message ?? err) });
			}

			/* ---- 2. 正文：只有真被改了才整段替换，否则一个字节不碰 ---- */
			const bodyGiven = typeof payload.body === "string";
			const linksGiven = Array.isArray(payload.links);
			if (bodyGiven || linksGiven) {
				const onDisk = parseManagedBlock(splitFrontmatter(raw).body);
				const free = bodyGiven ? payload.body : onDisk.free;
				const links = linksGiven
					? [...new Set(payload.links.map((s) => String(s).trim()).filter(Boolean))]
					: onDisk.links;
				next = replaceBody(next, composeBody(free, links, titleToPath));
			}

			// 内容没变就不写。省掉一次无谓的 mtime 变动与一次重索引
			if (next === raw) return json(res, 200, { ok: true, unchanged: true, revisionHash: baseRevision });

			/* ---- 3. 写入：转发给上游，比对与写盘在它那一次请求里完成 ---- */
			let up;
			try {
				up = await callUpstream("PUT", "/api/l2/page", {
					path: payload.path,
					content: next,
					baseRevision,
				});
			} catch (err) {
				return json(res, 503, {
					ok: false,
					reason: err.reason ?? "upstream_error",
					error: `保存不可用：${err.message}`,
				});
			}
			if (up.status === 409) {
				return json(res, 409, {
					ok: false,
					reason: "stale",
					error: "这一页在你保存的瞬间被改过了",
					revisionHash: up.data?.revisionHash ?? "",
					content: up.data?.content ?? "",
				});
			}
			if (up.status !== 200) {
				return json(res, 502, {
					ok: false,
					reason: "upstream_error",
					error: up.data?.error ?? `上游返回 ${up.status}`,
				});
			}
			// 刻意**没有** reverseSynced —— 对端写入已按 §11 拆掉。
			// 关联只存发起的那一边，反向链接由 GET /api/page 的 backlinks 查询得出。
			return json(res, 200, { ok: true, revisionHash: up.data?.revisionHash ?? "" });
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

			// 到这里为止全是校验，一个字节都还没写。
			// 真正的写入交给上游，而且**转入后台**：l2_archive 要两次模型调用、
			// 几秒到十几秒，不能用「保存中…」的模态框把人糊住——那正好打在
			// 这个产品最贵的成本上（0.5：等待时间）。
			const type = payload.type === "entity" ? "entity" : "concept";
			const tags = [...new Set([...(payload.tags ?? []).map((s) => String(s).trim())])].filter(Boolean);
			const links = [...new Set((payload.links ?? []).map((s) => String(s).trim()).filter(Boolean))];
			const bodyLines = [
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
			if (links.length) bodyLines.push("", MANAGED_HEADING, "", ...links.map((l) => `- [[${l}]]`));

			const task = startArchiveTask({
				title,
				type,
				tags,
				body: bodyLines.join("\n"),
				source,
				factCount: facts.length,
			});
			// 立刻返回，界面照常可浏览（§4「归档的交互：后台任务，不锁死界面」）
			return json(res, 202, { ok: true, taskId: task.id, state: task.state });
		}

		// 后台归档任务的进度。前端轮询这个，不轮询就什么也不会发生——
		// 任务本身在服务端跑，关掉页面也不会中断。
		if (req.method === "GET" && url.pathname === "/api/task") {
			const t = TASKS.get(url.searchParams.get("id"));
			if (!t) return json(res, 404, { error: "没有这个任务" });
			return json(res, 200, t);
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
