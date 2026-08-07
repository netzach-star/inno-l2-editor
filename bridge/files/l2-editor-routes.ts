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
//   POST /api/l2/archive   把 l2_archive 工具暴露成 HTTP（五个副作用它全包）
//   POST /api/l2/search    把 L2Memory.search 暴露成 HTTP（BM25 + 一跳图扩展）
//   PUT  /api/l2/page      读盘比对 baseRevision → writeText → indexPageByPath
//
// 为什么 PUT 不用上游现成的 `PUT /api/wiki/page`：那条只收 {path, content}，
// 没有版本参数、不做任何检查。而"插件先 GET 算 hash → 比对 → 再调上游 PUT"
// 会把检查与写入拆到两个进程里，中间那几十毫秒 l2_archive 的
// maintainLinkedWikiPages 照样插得进来——那不是乐观锁，是一条会被当成乐观锁的
// 护栏（红线 3）。所以新增这一条，让比对与写入在**同一次请求里**做完。
// 上游自己的 `PUT /api/wiki/page` 一个字节不动，Notebook 继续用它。

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createL2Tools } from "./l2-tools.js";
import { getL2Memory } from "./l2-memory.js";
import { writeText } from "../../storage/file-store.js";

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
