import { EventEmitter } from "./event-emitter.js";

/**
 * 对话寄存区：把聊天里值得沉淀的「一问一答」攒起来，一次性交给 L2 结构化编辑器
 * （独立插件，默认跑在 :4321）去生成 wiki 页面。
 *
 * 存在的理由：在此之前，用户要把对话变成知识库页面只能手动复制粘贴。
 *
 * 边界：这里只负责「攒」和「交」。生成、引文核对、落盘都在插件那边完成——
 * 主项目不承担任何知识编译逻辑，两者只通过一个 HTTP 接口相处。
 */

export interface StagedPair {
	readonly id: string;
	/** 用户的提问原文 */
	readonly question: string;
	/** AI 的完整回答原文 */
	readonly answer: string;
	/** 列表里显示的标题，取自提问前若干字 */
	readonly title: string;
	readonly addedAt: number;
}

interface StagingStoreEvents {
	change: void;
}

const STORAGE_KEY = "inno.staging.pairs";
const PLUGIN_URL_KEY = "inno.staging.pluginUrl";
const DEFAULT_PLUGIN_URL = "http://localhost:4321";

/**
 * 标题取提问的前 20 个字。
 *
 * 为什么是 20：寄存区面板在右侧栏里，宽度大约 260–500px，13px 中文字号下
 * 一行放得下 20 个字左右。再长就得截断换行，反而看不清；再短（比如 10 字）
 * 很多提问会被切在半句上，认不出是哪一条。
 */
const TITLE_MAX = 20;

export function makeTitle(question: string): string {
	const flat = question.replace(/\s+/g, " ").trim();
	if (flat.length === 0) return "（空提问）";
	return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX)}…`;
}

function load(): StagedPair[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(p): p is StagedPair =>
				typeof p === "object" && p !== null &&
				typeof (p as StagedPair).id === "string" &&
				typeof (p as StagedPair).answer === "string",
		);
	} catch {
		return [];
	}
}

class StagingStoreImpl extends EventEmitter<StagingStoreEvents> {
	pairs: StagedPair[] = load();
	isSending = false;
	lastError: string | null = null;

	get count(): number {
		return this.pairs.length;
	}

	/** 该条回答是不是已经在寄存区里了（用于把按钮变成「已加入」） */
	has(answer: string): boolean {
		return this.pairs.some((p) => p.answer === answer);
	}

	add(question: string, answer: string): void {
		if (!answer.trim()) return;
		if (this.has(answer)) return;
		this.pairs = [
			...this.pairs,
			{
				id: `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				question,
				answer,
				title: makeTitle(question),
				addedAt: Date.now(),
			},
		];
		this.persist();
	}

	remove(id: string): void {
		this.pairs = this.pairs.filter((p) => p.id !== id);
		this.persist();
	}

	clear(): void {
		this.pairs = [];
		this.persist();
	}

	get pluginUrl(): string {
		return localStorage.getItem(PLUGIN_URL_KEY) || DEFAULT_PLUGIN_URL;
	}

	setPluginUrl(url: string): void {
		localStorage.setItem(PLUGIN_URL_KEY, url.replace(/\/+$/, ""));
		this.emit("change", undefined);
	}

	/**
	 * 交给插件：先把攒下的问答冻结成一份来源，再打开插件页面自动开始生成。
	 *
	 * 只传一个 sourceId 过去，不把内容塞进 URL——内容已经在插件那边冻结好了，
	 * 这样地址短、可刷新，也不会因为对话太长撑爆地址栏。
	 */
	async summarize(): Promise<void> {
		if (this.pairs.length === 0 || this.isSending) return;
		this.isSending = true;
		this.lastError = null;
		this.emit("change", undefined);

		try {
			const segments = this.pairs.map((p) => `问：${p.question.trim()}\n\n答：${p.answer.trim()}`);
			const title =
				this.pairs.length === 1
					? this.pairs[0]!.title
					: `对话摘录 · ${this.pairs[0]!.title} 等 ${this.pairs.length} 条`;

			const res = await fetch(`${this.pluginUrl}/api/sources`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title, segments }),
			});
			const data = (await res.json()) as { ok?: boolean; error?: string; source?: { sourceId: string } };
			if (!res.ok || !data.source?.sourceId) {
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			window.open(`${this.pluginUrl}/?source=${encodeURIComponent(data.source.sourceId)}&auto=1`, "_blank");
		} catch (err) {
			// 最常见的失败就是插件没启动。如实说清楚，别让用户以为是自己点错了
			const detail = err instanceof Error ? err.message : String(err);
			this.lastError = `送不过去（${detail}）。确认 L2 编辑器已启动，地址是 ${this.pluginUrl}`;
		} finally {
			this.isSending = false;
			this.emit("change", undefined);
		}
	}

	private persist(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.pairs));
		} catch {
			// 存不下就算了，内存里的还在
		}
		this.emit("change", undefined);
	}
}

export const stagingStore = new StagingStoreImpl();
