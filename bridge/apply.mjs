#!/usr/bin/env node
// 把「对话寄存区」+「L2 编辑器转发路由」装进 InnoSpark / 从中卸载。
//
// 为什么不用 git patch：patch 按行号和上下文匹配，上游动一行就整个失败，
// 而且报错看不出哪里不对。这里改成「按锚点字符串替换」——锚点找不到就明确
// 告诉你是哪一处、上游可能改了什么，而不是甩一句 "patch does not apply"。
//
// 幂等：装过了会跳过；卸载会还原。任何一步失败都不写盘（先全算好再落地）。
//
// ── v2.0 加了什么（见设计文档 §4 / §10.1 / 裁定二、三）──
//
//   后端：apps/inno-agent/src/memory/l2/l2-editor-routes.ts   ← 整个文件是新增的
//         server.ts 只锚 **2 处**：一个 import、一个 dispatch 调用。
//
// 路由实现刻意放进新文件而不是内联进 server.ts，就是为了把锚点面压到最小：
// 锚点是这个维护模型唯一的失效点，锚得越少、越短，上游升级时越不容易断。
// 三条路由本身全是**纯新增**，不改上游任何既有代码路径——
// 上游自己的 `PUT /api/wiki/page` 一个字节不动，Notebook 继续用它（裁定二）。

import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 判断是否已安装的标记。v2.0 换成后端那条 import——单一脚本装全部，
// 后端那条在就说明整套都在。
const MARK = "l2-editor-routes.js";
// v1.1.0 的标记。用来识别「装着旧版」这种状态并给出可执行的提示，
// 而不是让锚点对不上、甩一句看不懂的错。
const MARK_V1 = "staging-store.js";

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const warn = (s) => console.log(`  ${c.y}!${c.x} ${s}`);
const die = (s, hint) => {
	console.error(`\n  ${c.r}✗ ${s}${c.x}`);
	if (hint) console.error(`    ${c.d}${hint}${c.x}`);
	console.error("");
	process.exit(1);
};

const [, , rawTarget, mode = "install"] = process.argv;
if (!rawTarget) die("用法：node apply.mjs <inno-agent 目录> [install|uninstall|check]");
if (!["install", "uninstall", "check"].includes(mode)) die(`不认识的模式：${mode}`, "只能是 install / uninstall / check");
const TARGET = rawTarget.replace(/\/+$/, "");

const WEB = join(TARGET, "apps", "inno-agent", "web", "src");
const SRC = join(TARGET, "apps", "inno-agent", "src");
const paths = {
	appStore: join(WEB, "stores", "app-store.ts"),
	workspacePanel: join(WEB, "react", "WorkspacePanel.tsx"),
	chatCenter: join(WEB, "react", "ChatCenter.tsx"),
	zh: join(WEB, "i18n", "locales", "zh-CN.json"),
	en: join(WEB, "i18n", "locales", "en.json"),
	newStore: join(WEB, "stores", "staging-store.ts"),
	newPanel: join(WEB, "react", "StagingArea.tsx"),
	// v2.0 新增：后端
	server: join(SRC, "server.ts"),
	newRoutes: join(SRC, "memory", "l2", "l2-editor-routes.ts"),
};

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/* ---------------- 前置检查 ---------------- */

if (!(await exists(join(TARGET, "package.json")))) {
	die(`${TARGET} 里没有 package.json`, "第一个参数要指向 InnoSpark 的安装目录（有 restart-dev.sh 的那一层）");
}
for (const key of ["appStore", "workspacePanel", "chatCenter", "zh", "en", "server"]) {
	if (!(await exists(paths[key]))) {
		die(`找不到 ${paths[key]}`, "这看起来不像 InnoSpark 的代码结构，确认目录是否正确");
	}
}

/* ---------------- 改动清单 ---------------- */

// 每条：[锚点, 替换成什么]。锚点必须在原文中恰好出现一次
const EDITS = [
	[paths.appStore,
		`export type RightPanelTab = "notebook" | "preview"`,
		`export type RightPanelTab = "notebook" | "staging" | "preview"`],
	[paths.appStore,
		`const VALID_TABS: RightPanelTab[] = ["notebook", "preview"`,
		`const VALID_TABS: RightPanelTab[] = ["notebook", "staging", "preview"`],

	[paths.workspacePanel,
		`, FolderKanban, Settings, Sparkles, UserRound } from "lucide-react";`,
		`, FolderKanban, Inbox, Settings, Sparkles, UserRound } from "lucide-react";`],
	[paths.workspacePanel,
		`import { Notebook } from "./Notebook.js";`,
		`import { Notebook } from "./Notebook.js";\nimport { StagingArea } from "./StagingArea.js";\nimport { stagingStore } from "../stores/staging-store.js";`],
	[paths.workspacePanel,
		`const TAB_ORDER: RightPanelTab[] = ["preview", "notebook", "profile"`,
		`const TAB_ORDER: RightPanelTab[] = ["preview", "notebook", "staging", "profile"`],
	[paths.workspacePanel,
		`\tnotebook: <BookOpen size={14} />,`,
		`\tnotebook: <BookOpen size={14} />,\n\tstaging: <Inbox size={14} />,`],
	[paths.workspacePanel,
		`\t\tcase "notebook":\n\t\t\treturn <Notebook />;`,
		`\t\tcase "notebook":\n\t\t\treturn <Notebook />;\n\t\tcase "staging":\n\t\t\treturn <StagingArea />;`],
	[paths.workspacePanel,
		`const HIDDEN_IN_SIMPLE: RightPanelTab[] = ["notebook", "profile"`,
		`const HIDDEN_IN_SIMPLE: RightPanelTab[] = ["notebook", "staging", "profile"`],
	[paths.workspacePanel,
		`\tconst simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);`,
		`\tconst simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);\n\t// 寄存区条数做成徽标：不切标签也能看见它在攒\n\tconst stagedCount = useStoreSnapshot(stagingStore, () => stagingStore.pairs.length);`],
	[paths.workspacePanel,
		`\t\t\t\t\t\t\t\t{TAB_ICONS[tab]}\n\t\t\t\t\t\t\t\t{compact ? null : label}\n\t\t\t\t\t\t\t</button>`,
		`\t\t\t\t\t\t\t\t{TAB_ICONS[tab]}\n\t\t\t\t\t\t\t\t{compact ? null : label}\n\t\t\t\t\t\t\t\t{tab === "staging" && stagedCount > 0 ? (\n\t\t\t\t\t\t\t\t\t<span className="ml-0.5 rounded-full bg-[var(--inno-accent)] px-1.5 text-[10px] font-medium leading-4 text-white">\n\t\t\t\t\t\t\t\t\t\t{stagedCount}\n\t\t\t\t\t\t\t\t\t</span>\n\t\t\t\t\t\t\t\t) : null}\n\t\t\t\t\t\t\t</button>`],

	[paths.chatCenter,
		`, Search, FileCode2, Sparkles } from "lucide-react";`,
		`, Search, FileCode2, Sparkles, Inbox, Check } from "lucide-react";`],
	[paths.chatCenter,
		`import { appStore } from "../stores/app-store.js";`,
		`import { appStore } from "../stores/app-store.js";\nimport { stagingStore } from "../stores/staging-store.js";`],
	[paths.chatCenter,
		`function MessageBubble({ message, showChannel }: { message: ChatMessage; showChannel?: boolean }) {`,
		`/**
 * 「加入寄存区」——把这段回答连同它对应的提问一起攒起来，
 * 之后一次性交给 L2 结构化编辑器整理成 wiki 页面。
 *
 * 只出现在已经落定的整段回答下方：流式过程中的文本走的是另一条渲染路径，
 * 不经过 MessageBubble，所以天然满足「每段完整回答」。
 */
function findQuestionFor(messages: ChatMessage[], index: number): string {
	for (let i = index - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") return messages[i]!.content;
	}
	return "";
}

function StageButton({ question, answer }: { question: string; answer: string }) {
	const { t } = useTranslation();
	const staged = useStoreSnapshot(stagingStore, () => stagingStore.has(answer));
	if (!answer.trim()) return null;

	return (
		<div className="mt-2 flex justify-end">
			<button
				className={staged
					? "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--inno-success)]"
					: "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-accent)]"}
				title={staged ? t("staging.added", "已在寄存区") : t("staging.add", "加入寄存区")}
				disabled={staged}
				onClick={() => stagingStore.add(question, answer)}
			>
				{staged ? <Check size={13} /> : <Inbox size={13} />}
				{staged ? t("staging.added", "已在寄存区") : t("staging.add", "加入寄存区")}
			</button>
		</div>
	);
}

function MessageBubble({ message, question, showChannel }: { message: ChatMessage; question?: string; showChannel?: boolean }) {`],
	[paths.chatCenter,
		`\t\t\t\t<AssistantContent content={message.content} />\n\t\t\t\t{message.error ? (\n\t\t\t\t\t<div className={message.content.trim() ? "mt-2" : ""}>\n\t\t\t\t\t\t<ErrorBlock error={message.error} />\n\t\t\t\t\t</div>\n\t\t\t\t) : null}`,
		`\t\t\t\t<AssistantContent content={message.content} />\n\t\t\t\t{message.error ? (\n\t\t\t\t\t<div className={message.content.trim() ? "mt-2" : ""}>\n\t\t\t\t\t\t<ErrorBlock error={message.error} />\n\t\t\t\t\t</div>\n\t\t\t\t) : null}\n\t\t\t\t{!message.error ? <StageButton question={question ?? ""} answer={message.content} /> : null}`],
	// 只锚一行 MessageBubble 调用，不碰外面的 map 结构。
	// 上游在这一带加过 data-conversation-turn 的包裹层，锚大了必然被牵连。
	[paths.chatCenter,
		`<MessageBubble message={message} showChannel={multiChannel} />`,
		`<MessageBubble message={message} question={findQuestionFor(chat.messages, index)} showChannel={multiChannel} />`],

	// ── v2.0 后端：只有这两条锚点，实现全在新增的 l2-editor-routes.ts 里 ──
	[paths.server,
		`import { buildWikiGraph } from "./memory/l2/wiki-graph.js";`,
		`import { buildWikiGraph } from "./memory/l2/wiki-graph.js";\nimport { handleL2EditorRoute } from "./memory/l2/l2-editor-routes.js";`],
	// 挂在 Wiki API 之前：三条 /api/l2/* 与上游任何既有路由都不重名，
	// 先匹配后匹配都一样，放这里只是为了让它们在代码里挨着 wiki 那组。
	[paths.server,
		`\t\t// --- Wiki API ---`,
		`\t\t// --- L2 编辑器转发路由（inno-l2-editor v2.0，纯新增，不碰下面任何一条）---
\t\tif (
\t\t\tawait handleL2EditorRoute(method, url, req, res, {
\t\t\t\tl2DataDir,
\t\t\t\tjson,
\t\t\t\treadBody,
\t\t\t\tsafeJoin,
\t\t\t\tgetSession,
\t\t\t\tisL2Enabled: () => config.memory?.l2Enabled !== false,
\t\t\t})
\t\t) {
\t\t\treturn;
\t\t}

\t\t// --- Wiki API ---`],
];

const I18N = {
	[paths.zh]: {
		tab: "寄存区",
		staging: {
			title: "对话寄存区", add: "加入寄存区", added: "已在寄存区", count: "{{n}} 条待整理",
			hintShort: "在回答下方点「加入寄存区」", empty: "还没有攒下任何对话",
			emptyHint: "聊到有价值的内容时，在那段回答下方点「加入寄存区」。攒够了一次性交给 L2 编辑器整理成知识库页面。",
			summarize: "开始总结", sending: "送出中…", clear: "全部清空", remove: "移出寄存区",
			settings: "编辑器地址", pluginUrl: "L2 编辑器地址",
		},
	},
	[paths.en]: {
		tab: "Staging",
		staging: {
			title: "Staging", add: "Add to staging", added: "In staging", count: "{{n}} pending",
			hintShort: "Use “Add to staging” under a reply", empty: "Nothing staged yet",
			emptyHint: "When a reply is worth keeping, click “Add to staging” below it. Send them to the L2 editor together to build wiki pages.",
			summarize: "Summarize", sending: "Sending…", clear: "Clear all", remove: "Remove",
			settings: "Editor URL", pluginUrl: "L2 editor URL",
		},
	},
};

/* ---------------- 执行 ---------------- */

// v2.0 的标记在 server.ts（后端那条 import）——单一脚本装全部，它在就说明整套都在
const installed = (await readFile(paths.server, "utf8")).includes(MARK);
// 只装了 v1.1.0 的那半套：前端锚点已被替换、后端还没动
const v1Installed = (await readFile(paths.workspacePanel, "utf8")).includes(MARK_V1);

/*
 * check 模式：**不写一个字节**，只报告锚点还在不在。
 *
 * 这是设计文档 §13.2 的核心风险控制。锚点是这套维护模型唯一的失效点，
 * 而历史上它是在**用户安装时**才断的（`89c2a69` → `924ccbc`，上游给消息列表
 * 加了 data-conversation-turn 包裹层）。这个模式的用途就是让它**先在我们这边断**。
 *
 * 按裁定二「锚点失效就重写脚本」，这份输出直接就是重写清单：
 * 哪几个锚点没了、在哪个文件、锚的是什么。
 */
if (mode === "check") {
	console.log(`  基线状态：${installed ? "已装 v2.0" : v1Installed ? "已装 v1.1.0（v2.0 未装）" : "未安装（上游原样）"}\n`);
	let bad = 0;
	const cache = new Map();
	for (const [file, anchor, replacement] of EDITS) {
		if (!cache.has(file)) cache.set(file, await readFile(file, "utf8"));
		const src = cache.get(file);
		// 已装的情况下原锚点已被替换掉，该找的是替换后的片段
		const needle = installed ? replacement : anchor;
		const hits = src.split(needle).length - 1;
		const where = `${file.replace(`${TARGET}/`, "")}`;
		const brief = anchor.split("\n")[0].slice(0, 64);
		if (hits === 1) ok(`${where}  ${c.d}${brief}${c.x}`);
		else {
			bad++;
			console.error(`  ${c.r}✗${c.x} ${where}  命中 ${hits} 次（应为 1）\n      ${c.d}${brief}${c.x}`);
		}
	}
	// 新增文件不占锚点，但装了之后应该在
	if (installed) {
		for (const p of [paths.newStore, paths.newPanel, paths.newRoutes]) {
			if (await exists(p)) ok(`${p.replace(`${TARGET}/`, "")} 在`);
			else { bad++; console.error(`  ${c.r}✗${c.x} ${p.replace(`${TARGET}/`, "")} 不见了`); }
		}
	}
	console.log("");
	if (bad > 0) {
		console.error(`  ${c.r}${bad} 处锚点失配${c.x}——上游这一带改过了，需要按上面的清单重写 apply.mjs。\n`);
		process.exit(1);
	}
	ok(`全部 ${EDITS.length} 个锚点都在`);
	console.log("");
	process.exit(0);
}

if (mode === "install" && !installed && v1Installed) {
	die(
		"检测到已经装着 v1.1.0 的「对话寄存区」",
		"v2.0 是单一脚本装全部（寄存区 + 三条转发路由），不做增量安装。\n" +
			"    请先用 v1.1.0 那份仓库卸载，再回来装 v2.0：\n" +
			"      <v1.1.0 仓库>/bridge/install.sh \"" + TARGET + "\" --uninstall\n" +
			"    卸载后前端会恢复成上游原样，装 v2.0 会把寄存区一起装回来（功能是 v1.1.0 的超集）。",
	);
}

if (mode === "uninstall") {
	if (!installed) {
		if (v1Installed) {
			die(
				"这里装的是 v1.1.0，不是 v2.0，本脚本卸载不了它",
				"v1.1.0 的锚点和 v2.0 不同。请用 v1.1.0 那份仓库的 install.sh --uninstall。",
			);
		}
		warn("本来就没装，无需卸载");
		process.exit(0);
	}
	// 先全部算好，再一次性落地——中途失败不留半成品
	const out = new Map();
	for (const [file, anchor, replaced] of EDITS) {
		const src = out.get(file) ?? (await readFile(file, "utf8"));
		if (!src.includes(replaced)) die(`卸载失败：${file} 里找不到要还原的片段`, "文件可能被手工改过，请用 git checkout 还原");
		out.set(file, src.replace(replaced, anchor));
	}
	for (const [file, text] of out) await writeFile(file, text, "utf8");
	for (const [file, spec] of Object.entries(I18N)) {
		const j = JSON.parse(await readFile(file, "utf8"));
		delete j.staging;
		if (j.workspace?.tabs) delete j.workspace.tabs.staging;
		void spec;
		await writeFile(file, `${JSON.stringify(j, null, "\t")}\n`, "utf8");
	}
	await rm(paths.newStore, { force: true });
	await rm(paths.newPanel, { force: true });
	await rm(paths.newRoutes, { force: true });
	ok("已卸载（含后端转发路由）。记得重新 npm run build");
	process.exit(0);
}

if (installed) { warn("已经装过了，跳过"); process.exit(0); }

// 先把所有替换算完，任何一个锚点对不上就中止，一个字节都不写
const out = new Map();
for (const [file, anchor, replacement] of EDITS) {
	const src = out.get(file) ?? (await readFile(file, "utf8"));
	const hits = src.split(anchor).length - 1;
	if (hits === 0) {
		die(
			`在 ${file.replace(TARGET, "…")} 里找不到锚点`,
			`上游可能改动了这一处。锚点片段：\n      ${anchor.split("\n")[0].slice(0, 80)}`,
		);
	}
	if (hits > 1) die(`锚点在 ${file.replace(TARGET, "…")} 里出现了 ${hits} 次，无法确定改哪个`);
	out.set(file, src.replace(anchor, replacement));
}

// 落地
await mkdir(dirname(paths.newStore), { recursive: true });
await writeFile(paths.newStore, await readFile(join(HERE, "files", "staging-store.ts"), "utf8"), "utf8");
await writeFile(paths.newPanel, await readFile(join(HERE, "files", "StagingArea.tsx"), "utf8"), "utf8");
ok("新增 staging-store.ts / StagingArea.tsx");

await mkdir(dirname(paths.newRoutes), { recursive: true });
await writeFile(paths.newRoutes, await readFile(join(HERE, "files", "l2-editor-routes.ts"), "utf8"), "utf8");
ok("新增 l2-editor-routes.ts（三条转发路由）");

for (const [file, text] of out) {
	await writeFile(file, text, "utf8");
	ok(`改好 ${file.replace(`${TARGET}/`, "")}`);
}

for (const [file, spec] of Object.entries(I18N)) {
	const j = JSON.parse(await readFile(file, "utf8"));
	j.staging = spec.staging;
	j.workspace ??= {};
	j.workspace.tabs ??= {};
	j.workspace.tabs.staging = spec.tab;
	await writeFile(file, `${JSON.stringify(j, null, "\t")}\n`, "utf8");
	ok(`补好 ${file.replace(`${TARGET}/`, "")}`);
}
