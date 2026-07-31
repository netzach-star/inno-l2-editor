import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, ExternalLink, Settings2, Inbox } from "lucide-react";
import { stagingStore } from "../stores/staging-store.js";
import { useStoreSnapshot } from "./hooks.js";

/**
 * 对话寄存区。攒「一问一答」，一次性交给 L2 结构化编辑器生成 wiki 页。
 * 编译、引文核对、落盘都在插件那边，这里只负责攒和交。
 */
/** 列表里那行预览：把 markdown 记号抹掉，否则满屏 ## 和 --- 很难读 */
function previewOf(answer: string): string {
	return answer
		.replace(/```[\s\S]*?```/g, " ")       // 代码块整块去掉
		.replace(/^\s*[-*_]{3,}\s*$/gm, " ")   // 分隔线
		.replace(/^#{1,6}\s*/gm, "")           // 标题记号
		.replace(/\[\[([^\]]+)\]\]/g, "$1")    // 双链只留文字
		.replace(/[*_`>|]/g, "")               // 行内记号
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 90);
}

export function StagingArea() {
	const { t } = useTranslation();
	const [showSettings, setShowSettings] = useState(false);
	const [urlDraft, setUrlDraft] = useState(stagingStore.pluginUrl);
	const state = useStoreSnapshot(stagingStore, () => ({
		pairs: stagingStore.pairs,
		isSending: stagingStore.isSending,
		lastError: stagingStore.lastError,
		pluginUrl: stagingStore.pluginUrl,
	}));

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 p-3">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
				<div className="flex items-center justify-between gap-2 border-b border-[var(--inno-border)] px-3 py-2">
					<div className="min-w-0">
						<div className="text-sm font-medium text-[var(--inno-text)]">
							{t("staging.title", "对话寄存区")}
						</div>
						<div className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
							{state.pairs.length > 0
								? t("staging.count", "{{n}} 条待整理", { n: state.pairs.length })
								: t("staging.hintShort", "在回答下方点「加入寄存区」")}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<button
							className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							title={t("staging.settings", "编辑器地址")}
							onClick={() => setShowSettings((v) => !v)}
						>
							<Settings2 size={14} />
						</button>
						{state.pairs.length > 0 ? (
							<button
								className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-danger-bg)] hover:text-[var(--inno-danger)]"
								title={t("staging.clear", "全部清空")}
								onClick={() => stagingStore.clear()}
							>
								<Trash2 size={14} />
							</button>
						) : null}
					</div>
				</div>

				{showSettings ? (
					<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-2">
						<label className="mb-1 block text-xs text-[var(--inno-text-muted)]">
							{t("staging.pluginUrl", "L2 编辑器地址")}
						</label>
						<div className="flex gap-1.5">
							<input
								className="min-w-0 flex-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none"
								value={urlDraft}
								onChange={(e) => setUrlDraft(e.target.value)}
								placeholder="http://localhost:4321"
							/>
							<button
								className="shrink-0 rounded-md bg-[var(--inno-surface)] px-2 py-1 text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
								onClick={() => {
									stagingStore.setPluginUrl(urlDraft);
									setShowSettings(false);
								}}
							>
								{t("common.save", "保存")}
							</button>
						</div>
					</div>
				) : null}

				<div className="min-h-0 flex-1 overflow-y-auto">
					{state.pairs.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
							<Inbox size={28} className="text-[var(--inno-text-subtle)]" />
							<p className="text-sm text-[var(--inno-text-muted)]">
								{t("staging.empty", "还没有攒下任何对话")}
							</p>
							<p className="text-xs text-[var(--inno-text-subtle)]">
								{t(
									"staging.emptyHint",
									"聊到有价值的内容时，在那段回答下方点「加入寄存区」。攒够了一次性交给 L2 编辑器整理成知识库页面。",
								)}
							</p>
						</div>
					) : (
						state.pairs.map((pair, i) => (
							<div
								key={pair.id}
								className="group relative border-b border-[var(--inno-border)] px-3 py-2 transition-colors hover:bg-[var(--inno-surface-muted)]"
							>
								<div className="flex items-start gap-2">
									<span className="mt-0.5 shrink-0 rounded bg-[var(--inno-surface-muted)] px-1.5 text-xs tabular-nums text-[var(--inno-text-subtle)]">
										{i + 1}
									</span>
									<div className="min-w-0 flex-1">
										<div className="truncate text-sm text-[var(--inno-text)]">{pair.title}</div>
										<div className="mt-0.5 line-clamp-2 text-xs text-[var(--inno-text-muted)]">
											{previewOf(pair.answer)}
										</div>
									</div>
									<button
										className="shrink-0 rounded p-1 text-[var(--inno-text-subtle)] opacity-0 transition-opacity hover:bg-[var(--inno-danger-bg)] hover:text-[var(--inno-danger)] group-hover:opacity-100"
										title={t("staging.remove", "移出寄存区")}
										onClick={() => stagingStore.remove(pair.id)}
									>
										<Trash2 size={13} />
									</button>
								</div>
							</div>
						))
					)}
				</div>

				{state.lastError ? (
					<div className="border-t border-[var(--inno-danger)] bg-[var(--inno-danger-bg)] px-3 py-2 text-xs text-[var(--inno-danger)]">
						{state.lastError}
					</div>
				) : null}

				<div className="flex items-center justify-between gap-2 border-t border-[var(--inno-border)] px-3 py-2">
					<span className="min-w-0 truncate text-xs text-[var(--inno-text-subtle)]">
						{state.pluginUrl.replace(/^https?:\/\//, "")}
					</span>
					<button
						className="inno-primary-button flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-white disabled:opacity-50"
						disabled={state.pairs.length === 0 || state.isSending}
						onClick={() => void stagingStore.summarize()}
					>
						<ExternalLink size={14} />
						{state.isSending ? t("staging.sending", "送出中…") : t("staging.summarize", "开始总结")}
					</button>
				</div>
			</div>
		</div>
	);
}
