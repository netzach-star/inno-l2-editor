// L2 结构化编辑器的三条转发路由（inno-l2-editor v2.0 新增）
//
// 这个文件由 bridge/apply.mjs 拷进上游 apps/inno-agent/src/memory/l2/。
// 上游原本没有这个文件，所以它**不改上游任何一行既有逻辑**——
// server.ts 那边只需要两个锚点：一个 import、一个 dispatch 调用。
// 锚点面越小，上游升级时越不容易断（见设计文档 §13.2）。
//
// 三条路由都是**纯转发**：把上游已经有的能力暴露成 HTTP，不复制它的任何产物格式。
// 这是设计文档 0.6 那条原则的直接实现——
//   「如果你写的代码，输出必须和上游『逐字节可比』，那就是入口找错了。」
// 下面没有一处在拼 index.md / log.md / manifest 的格式。
//
//   POST /api/l2/archive        把 l2_archive 工具暴露成 HTTP（五个副作用它全包）
//   POST /api/l2/search         把 L2Memory.search 暴露成 HTTP（BM25 + 一跳图扩展）
//   PUT  /api/l2/page           读盘比对 baseRevision → writeText → indexPageByPath
//   POST /api/l2/page/concept   把**用户逐条核对过的**草稿落成 concept / entity 页
//
// 第四条为什么存在（这一条设计文档里没有，是施工时实测发现的缺口）：
// `l2_archive` 内部会对传入的 content 再跑一次 `summarizeContent`，
// **落盘的是模型重写的版本，而不是用户逐条勾选核对过的那一份**（原文只进 raw/ 与
// extracted/）。也就是说引文闸门把守住了，但守住的东西在最后一步又被模型改了一遍——
// 那正好把本项目的立项理由（"这条到底是不是它编的"）冲掉。
// 所以拆成两步：`l2_archive` 负责归档**资料**（它本来就是干这个的，五个副作用全包），
// 这一条负责把**用户批准的正文**落成页面。
//
// 为什么 PUT 不用上游现成的 `PUT /api/wiki/page`：那条只收 {path, content}，
// 没有版本参数、不做任何检查。而"插件先 GET 算 hash → 比对 → 再调上游 PUT"
// 会把检查与写入拆到两个进程里，中间那几十毫秒 l2_archive 的
// maintainLinkedWikiPages 照样插得进来——那不是乐观锁，是一条会被当成乐观锁的
// 护栏（红线 3）。所以新增这一条，让比对与写入在**同一次请求里**做完。
// 上游自己的 `PUT /api/wiki/page` 一个字节不动，Notebook 继续用它。

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { createL2Tools } from "./l2-tools.js";
import { getL2Memory } from "./l2-memory.js";
import { slugifyTitle } from "./wiki-linker.js";
import {
	appendLog,
	ensureL2Directories,
	parseFrontmatter,
	rebuildIndex,
	serializeFrontmatter,
} from "./wiki-maintainer.js";
import { readManifest } from "./manifest-store.js";
import { readText, writeText } from "../../storage/file-store.js";
import type { ManifestEntry, WikiPageFrontmatter } from "./types.js";

/** 上游 server.ts 里已有的那几个局部工具，由调用方注入，避免再开锚点去导出它们。 */
export interface L2EditorRouteDeps {
	l2DataDir: string;
	json(res: ServerResponse, status: number, data: unknown): void;
	readBody(req: IncomingMessage): Promise<unknown>;
	/** 越界返回 null，防路径穿越 */
	safeJoin(baseDir: string, userPath: string): string | null;
	/** 未初始化时会抛错，我们据此如实回 503 */
	getSession(): { model?: unknown; modelRegistry: unknown };
	isL2Enabled(): boolean;
}

/** 整个文件的**原始字节**的 sha256。 */
function revisionOf(fullPath: string): string {
	return createHash("sha256").update(readFileSync(fullPath)).digest("hex");
}

/**
 * l2_archive 的 execute 要一个 ExtensionContext。那是 PI 会话的上下文，
 * 一条 HTTP 路由里没有完整的一份。
 *
 * 这里只把工具**真正读到的**两个字段接上真实会话（model / modelRegistry），
 * 其余成员一律做成**会抛错的桩**——不是返回空值。
 *
 * 这个区别很重要：如果上游哪天让 l2_archive 用了别的 ctx 字段，
 * 抛错会当场炸出一条指名道姓的信息，而返回空值会让它静默走进错误分支，
 * 产出一个看起来成功、实际不对的归档。宁可响亮地失败（红线 3）。
 */
function forwardContext(deps: L2EditorRouteDeps): never | Record<string, unknown> {
	const session = deps.getSession();
	const notHere = (name: string) => () => {
		throw new Error(
			`[l2-editor-routes] l2_archive 用到了 ctx.${name}，而 HTTP 转发路由没有这个东西。` +
				`上游可能改了 l2_archive 的实现——请更新 bridge/files/l2-editor-routes.ts。`,
		);
	};
	return {
		// 真实的两个：和上游 agent 调 l2_archive 时用的是同一个模型
		model: session.model,
		modelRegistry: session.modelRegistry,
		// 其余：出现即报错
		get ui() { return notHere("ui")(); },
		mode: "rpc",
		hasUI: false,
		cwd: process.cwd(),
		get sessionManager() { return notHere("sessionManager")(); },
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: notHere("abort"),
		hasPendingMessages: () => false,
		shutdown: notHere("shutdown"),
		getContextUsage: notHere("getContextUsage"),
		compact: notHere("compact"),
		getSystemPrompt: notHere("getSystemPrompt"),
	};
}

const ARCHIVE_SOURCE_TYPES = new Set(["text", "markdown", "conversation", "pdf", "word", "image"]);

/**
 * 找这个标题**已经**落在哪个文件上。
 *
 * 口径照抄上游 `findExistingPage`（`wiki-linker.ts:193`）的先后顺序：
 * 先按 slug 猜路径，猜不中再扫目录、比对 frontmatter 的 title。
 * 之所以要扫，是因为同一个标题可能被写在别的文件名下（改过名、或早期建的）。
 */
function locatePage(l2DataDir: string, title: string, type: "concept" | "entity"): { path: string; exists: boolean } {
	const dir = type === "entity" ? "entities" : "concepts";
	const slugPath = `wiki/${dir}/${slugifyTitle(title)}.md`;
	if (existsSync(join(l2DataDir, slugPath))) return { path: slugPath, exists: true };

	const absDir = join(l2DataDir, "wiki", dir);
	if (existsSync(absDir)) {
		for (const file of readdirSync(absDir)) {
			if (!file.endsWith(".md")) continue;
			const rel = `wiki/${dir}/${file}`;
			const { frontmatter } = parseFrontmatter(readText(join(l2DataDir, rel)));
			if ((frontmatter?.title ?? "") === title) return { path: rel, exists: true };
		}
	}
	return { path: slugPath, exists: false };
}

/** 去重保序合并，上限 12 —— 与上游 `mergeTags`（`wiki-linker.ts:211`）同口径。 */
function mergeTags(...groups: string[][]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const g of groups) {
		for (const t of g) {
			const s = t.trim();
			if (!s || seen.has(s)) continue;
			seen.add(s);
			out.push(s);
		}
	}
	return out.slice(0, 12);
}

/**
 * 把一个 wiki 路径登记进某条 manifest 条目的 `wikiPages`。
 *
 * 上游没导出"往条目里加一条"的函数，只导出了反向的
 * `removeWikiPathFromManifest`。这里就是它的镜像写法——同样是
 * 「readManifest → 改内存里的对象 → JSON.stringify 整个写回」，
 * 序列化的是**上游自己读出来的对象**，不是我们发明的格式。
 *
 * 不登记的话，manifest 就不知道这一页属于哪份资料——那正是 §4 说的
 * "manifest 是唯一永久失配的"那个洞，而这一页恰恰是用户最在乎的那一页。
 */
function addWikiPathToManifest(l2DataDir: string, sourceId: string, wikiPath: string): boolean {
	const entries = readManifest(l2DataDir);
	let changed = false;
	for (const entry of entries as ManifestEntry[]) {
		if (entry.id !== sourceId) continue;
		if (!entry.wikiPages.includes(wikiPath)) {
			entry.wikiPages.push(wikiPath);
			entry.updatedAt = new Date().toISOString();
			changed = true;
		}
	}
	if (changed) {
		writeText(join(l2DataDir, "manifest.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}
	return changed;
}

/**
 * 处理三条 /api/l2/* 路由。命中并已响应返回 true，未命中返回 false 让上游继续往下匹配。
 */
export async function handleL2EditorRoute(
	method: string,
	url: string,
	req: IncomingMessage,
	res: ServerResponse,
	deps: L2EditorRouteDeps,
): Promise<boolean> {
	const { l2DataDir, json, readBody, safeJoin } = deps;

	/* ---------------- POST /api/l2/archive ---------------- */
	if (method === "POST" && url === "/api/l2/archive") {
		if (!deps.isL2Enabled()) {
			json(res, 409, { error: "L2 Wiki 知识库已在设置中关闭，当前不归档。" });
			return true;
		}

		let body: Record<string, unknown>;
		try {
			body = (await readBody(req)) as Record<string, unknown>;
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
			return true;
		}

		const title = typeof body.title === "string" ? body.title.trim() : "";
		const content = typeof body.content === "string" ? body.content : "";
		const sourceType = typeof body.sourceType === "string" ? body.sourceType : "markdown";
		if (!title) {
			json(res, 400, { error: "Missing title" });
			return true;
		}
		if (!content && typeof body.filePath !== "string") {
			json(res, 400, { error: "Missing content or filePath" });
			return true;
		}
		if (!ARCHIVE_SOURCE_TYPES.has(sourceType)) {
			json(res, 400, { error: `Unknown sourceType: ${sourceType}` });
			return true;
		}

		// 会话没起来就如实说，不降级、不偷偷直写文件（红线 3）
		let ctx: Record<string, unknown>;
		try {
			ctx = forwardContext(deps) as Record<string, unknown>;
		} catch (err) {
			json(res, 503, {
				error: "归档不可用：agent 会话尚未初始化",
				detail: err instanceof Error ? err.message : String(err),
			});
			return true;
		}

		const tools = createL2Tools(l2DataDir, () => deps.isL2Enabled(), getL2Memory(l2DataDir));
		const archive = tools.find((t) => t.name === "l2_archive");
		if (!archive) {
			json(res, 500, { error: "上游 createL2Tools 里找不到 l2_archive，签名可能变了" });
			return true;
		}

		const params: Record<string, unknown> = { title, sourceType };
		if (content) params.content = content;
		for (const key of ["filePath", "tags", "origin", "url", "sessionId", "force"]) {
			if (body[key] !== undefined) params[key] = body[key];
		}

		try {
			// 五个副作用（manifest / index.md / BM25 / overview / log.md）全部由它自己做，
			// 我们一件都不补——补了就是在复现产物而不是复现行为（0.6）。
			const result = await archive.execute(
				`http_${randomUUID().slice(0, 8)}`,
				params as never,
				undefined,
				undefined,
				ctx as never,
			);
			const text = (result.content ?? [])
				.map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
				.join("\n");
			json(res, 200, { ok: true, text, details: result.details ?? {} });
		} catch (err) {
			json(res, 500, {
				error: "归档失败",
				detail: err instanceof Error ? err.message : String(err),
			});
		}
		return true;
	}

	/* ---------------- POST /api/l2/search ---------------- */
	if (method === "POST" && url === "/api/l2/search") {
		let body: Record<string, unknown>;
		try {
			body = (await readBody(req)) as Record<string, unknown>;
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
			return true;
		}
		const query = typeof body.query === "string" ? body.query.trim() : "";
		const rawLimit = typeof body.limit === "number" ? body.limit : 20;
		const limit = Math.max(1, Math.min(100, Math.trunc(rawLimit)));
		if (!query) {
			json(res, 200, { results: [] });
			return true;
		}
		// search() 在索引不可用时返回 null。这两种情况必须分开报——
		// 把"查不到"显示成"没有结果"是红线 3 的问题。
		const results = await getL2Memory(l2DataDir).search(query, limit);
		if (results === null) {
			json(res, 503, { error: "检索索引不可用" });
			return true;
		}
		json(res, 200, { results });
		return true;
	}

	/* ---------------- POST /api/l2/page/concept ---------------- */
	if (method === "POST" && url === "/api/l2/page/concept") {
		if (!deps.isL2Enabled()) {
			json(res, 409, { error: "L2 Wiki 知识库已在设置中关闭，当前不写入。" });
			return true;
		}
		let body: Record<string, unknown>;
		try {
			body = (await readBody(req)) as Record<string, unknown>;
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
			return true;
		}

		const title = typeof body.title === "string" ? body.title.trim() : "";
		const pageBody = typeof body.body === "string" ? body.body : "";
		const type = body.type === "entity" ? "entity" : "concept";
		const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
		const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
		const sourcePagePath = typeof body.sourcePagePath === "string" ? body.sourcePagePath : "";
		// 覆盖必须是调用方的**显式动作**，路由本身不预设策略。
		// （插件默认传 true —— 人类 2026-08-07 裁定：撞名时用用户批准的版本覆盖。）
		const overwrite = body.overwrite === true;

		if (!title) {
			json(res, 400, { error: "Missing title" });
			return true;
		}
		if (!pageBody.trim()) {
			json(res, 400, { error: "Missing body" });
			return true;
		}

		ensureL2Directories(l2DataDir);
		const located = locatePage(l2DataDir, title, type);
		const fullPath = safeJoin(l2DataDir, located.path);
		if (!fullPath) {
			json(res, 400, { error: "Invalid wiki path" });
			return true;
		}

		const today = new Date().toISOString().slice(0, 10);
		let fm: WikiPageFrontmatter;

		if (located.exists) {
			if (!overwrite) {
				// 复用 §10.1 那套 409：两版都不静默丢失，交给用户决定
				json(res, 409, {
					error: "已经有一页叫这个标题了",
					exists: true,
					path: located.path,
					content: readFileSync(fullPath, "utf-8"),
					revisionHash: revisionOf(fullPath),
				});
				return true;
			}
			// 覆盖的是**正文**。frontmatter 里 created / status / confidence /
			// contested / contradictions 是页面自己的历史，不该被一次覆盖抹掉；
			// tags 与来源做并集——这一页现在确实同时属于新旧两份资料。
			const prev = parseFrontmatter(readText(fullPath)).frontmatter;
			fm = {
				...(prev ?? {}),
				title,
				created: prev?.created || today,
				type,
				tags: mergeTags([type], prev?.tags ?? [], tags),
				sources: mergeTags(prev?.sources ?? [], sourcePagePath ? [sourcePagePath] : []),
				source_ids: mergeTags(prev?.source_ids ?? [], sourceId ? [sourceId] : []),
				updated: today,
				status: prev?.status || "draft",
				confidence: prev?.confidence || "medium",
			} as WikiPageFrontmatter;
		} else {
			fm = {
				title,
				created: today,
				type,
				tags: mergeTags([type], tags),
				sources: sourcePagePath ? [sourcePagePath] : [],
				source_ids: sourceId ? [sourceId] : [],
				updated: today,
				status: "draft",
				confidence: "medium",
			} as WikiPageFrontmatter;
		}

		// frontmatter 由**上游自己的序列化器**生成，我们一个字段都不手拼——
		// 手拼就等于复现产物格式，必然漂移（0.6）。正文是用户的内容，不是格式。
		writeText(fullPath, `${serializeFrontmatter(fm)}\n${pageBody.trimEnd()}\n`);

		if (sourceId) addWikiPathToManifest(l2DataDir, sourceId, located.path);
		// 建页要补 rebuildIndex 与 appendLog —— 上游 l2_archive 建页时也补。
		// 裁定四说的"不补"只管**编辑**（上游 Notebook 编辑就不补），这里是建页。
		rebuildIndex(l2DataDir, readManifest(l2DataDir));
		await getL2Memory(l2DataDir).indexPageByPath(located.path);
		appendLog(
			l2DataDir,
			located.exists ? "update" : "create",
			title,
			[
				`- 页面: ${located.path}`,
				`- 类型: ${type}`,
				`- 来源: ${sourceId || "（未关联）"}`,
				"- 由 L2 结构化编辑器写入（内容经用户逐条复核）",
			].join("\n"),
		);

		json(res, 200, {
			ok: true,
			path: located.path,
			created: !located.exists,
			overwritten: located.exists,
			revisionHash: revisionOf(fullPath),
		});
		return true;
	}

	/* ---------------- PUT /api/l2/page（乐观锁） ---------------- */
	if (method === "PUT" && url === "/api/l2/page") {
		let body: Record<string, unknown>;
		try {
			body = (await readBody(req)) as Record<string, unknown>;
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
			return true;
		}
		const path = typeof body.path === "string" ? body.path : "";
		const content = typeof body.content === "string" ? body.content : undefined;
		const baseRevision = typeof body.baseRevision === "string" ? body.baseRevision : "";
		if (!path || content === undefined) {
			json(res, 400, { error: "Missing path or content" });
			return true;
		}
		// 没带 baseRevision 就拒绝。给一个"不带就直接覆盖"的后门，
		// 等于这条护栏可以被绕过，那它就不是锁。
		if (!baseRevision) {
			json(res, 400, { error: "Missing baseRevision（这条路由不接受无版本写入）" });
			return true;
		}
		const fullPath = safeJoin(l2DataDir, path);
		if (!fullPath) {
			json(res, 400, { error: "Invalid wiki path" });
			return true;
		}
		// 建页走 l2_archive，不走这里。这条只保存对既有页的编辑。
		if (!existsSync(fullPath)) {
			json(res, 404, { error: "Wiki page not found" });
			return true;
		}

		const current = revisionOf(fullPath);
		if (current !== baseRevision) {
			// 把磁盘现状一并给回去，让插件把两版摆到用户面前由他决定。
			// 用户确认覆盖时，用这里返回的 revisionHash 当 baseRevision 再请求一次即可
			// ——不设 force 开关，覆盖也必须是一次有版本依据的写入。
			json(res, 409, {
				error: "页面已被其他写入方修改",
				revisionHash: current,
				content: readFileSync(fullPath, "utf-8"),
			});
			return true;
		}

		// writeText 本身就是"临时文件 + 原子 rename"（storage/file-store.ts）
		writeText(fullPath, content);
		await getL2Memory(l2DataDir).indexPageByPath(path);
		// 刻意**不补** rebuildIndex 与 appendLog：上游自己的 Notebook 编辑
		// 就只做 writeText + indexPageByPath，不补才是"复现上游写入语义"（裁定四）。
		// 代价（改标题后 index.md 短暂指向旧标题）作为已知限制写在 README 里。
		json(res, 200, { path, saved: true, revisionHash: revisionOf(fullPath) });
		return true;
	}

	return false;
}
