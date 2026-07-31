// 子代理：一次性、无工具、与主代理完全隔离的独立会话。
// 两个用途：润色选中的段落（S-B）、从冻结来源编译 concept 页草稿（S-C 最小版）。
//
// 隔离配方逐条照搬自
//   扩展v3.0在建/packages/knowledge-infrastructure/src/pi-agent-session-factory.ts
// 但不复用 PiKnowledgeAgentSessionFactory 本身——它强依赖 PostgreSQL
// （knowledge_agent_sessions / knowledge_tasks），而润色不需要会话恢复与 task 关联。
// 取舍与红线对照见 扩展v3.0在建/docs/adr/ADR-V2-022-prototype-polish-session-isolation.md
//
// 这个模块是 server.mjs 惰性导入的可选件：没装依赖或没配模型时，
// 原型的其余功能照常工作，润色端点如实报「未配置」。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class PolishUnavailable extends Error {
	constructor(reason, message) {
		super(message);
		this.reason = reason; // "unconfigured" | "unavailable"
	}
}

/* ---------------- 模型配置 ---------------- */

/**
 * 按顺序找模型配置，先找到先用：
 *
 *   1. INNO_MODEL_CONFIG          —— 本插件专用，显式指定某个文件
 *   2. 插件目录 model.config.json —— 本插件专用，已 gitignore
 *   3. INNO_AGENT_DIR             —— 指向 InnoSpark 的**安装目录**（推荐）
 *   4. 上游自己那套 INNO_CONFIG_FILE / INNO_CONFIG_DIR / INNO_HOME
 *   5. ~/.inno-agent 兜底
 *
 * 第 4 条的路径解析照搬上游 `apps/inno-agent/src/runtime.ts` 的 resolveRuntimePaths。
 * 两边配置结构本来就同构（defaultProvider / defaultModel / providers），
 * 所以只要指对了文件，插件是零配置可用的——不用再抄一遍 key。
 *
 * ⚠️ 第 3 条是后补的，起因是一个真实事故：
 * InnoSpark 用 `restart-dev.sh` 启动时 INNO_HOME 默认是它自己的 `./runtime`，
 * 配置落在 `<安装目录>/runtime/config/config.json`；而这个变量**只存在于它自己的进程里**，
 * 插件另起一个进程时看不到。于是插件一路退到第 5 条，读了那份陈旧的
 * `~/.inno-agent/config/config.json`——两个程序读着两份不同的配置、两个不同的 key，
 * 主代理报 401 而插件显示「已配置」。
 *
 * 所以：**装了 InnoSpark 就把 INNO_AGENT_DIR 指向它的安装目录**，一份配置两边共用。
 * 启动脚本会自动设好。
 */
function configCandidates(root) {
	const out = [];
	const push = (path, from) => { if (path) out.push({ path, from }); };

	push(process.env.INNO_MODEL_CONFIG, "环境变量 INNO_MODEL_CONFIG");
	push(join(root, "model.config.json"), "插件目录 model.config.json");

	// 指向 InnoSpark 安装目录：一份配置两边共用，不会再各读各的
	if (process.env.INNO_AGENT_DIR) {
		push(
			join(process.env.INNO_AGENT_DIR, "runtime", "config", "config.json"),
			"INNO_AGENT_DIR 指向的 InnoSpark 安装目录",
		);
	}

	push(process.env.INNO_CONFIG_FILE, "环境变量 INNO_CONFIG_FILE（上游）");
	if (process.env.INNO_CONFIG_DIR) {
		push(join(process.env.INNO_CONFIG_DIR, "config.json"), "环境变量 INNO_CONFIG_DIR（上游）");
	}
	if (process.env.INNO_HOME) {
		push(join(process.env.INNO_HOME, "config", "config.json"), "环境变量 INNO_HOME（上游）");
	}
	push(join(process.cwd(), ".inno", "config.json"), "上游 legacy ./.inno/config.json");
	push(join(homedir(), ".inno-agent", "config", "config.json"), "上游默认 ~/.inno-agent（兜底）");
	return out;
}

export async function findModelConfig(root) {
	const tried = [];
	for (const c of configCandidates(root)) {
		tried.push(c.path);
		let raw;
		try {
			raw = await readFile(c.path, "utf8");
		} catch {
			continue;
		}
		try {
			return { ...c, raw: JSON.parse(raw) };
		} catch (err) {
			throw new PolishUnavailable("unconfigured", `${c.path} 不是合法 JSON：${err.message}`);
		}
	}
	throw new PolishUnavailable(
		"unconfigured",
		"没有找到模型配置。装了 InnoSpark 的话会自动读它的 config.json；" +
			"否则复制 model.config.example.json 为 model.config.json 并填入 apiKey。\n找过这些位置：\n" +
			tried.map((p) => `  · ${p}`).join("\n"),
	);
}

// key 单独用 INNO_API_KEY 覆盖，方便不把密钥写进任何文件
export async function loadModelConfig(root, pick) {
	const found = await findModelConfig(root);
	const cfg = found.raw;

	// 可以在设置里挑一个别的模型（只在本配置已有的模型里挑，不接受任意输入）
	const want = pick ?? {};
	const providerId = want.providerId || cfg.defaultProvider;
	const modelId = want.modelId || (want.providerId ? undefined : cfg.defaultModel);
	const provider = cfg.providers?.[providerId];
	const model = modelId
		? provider?.models?.find((m) => m.id === modelId)
		: provider?.models?.[0];
	if (!provider || !model) {
		throw new PolishUnavailable(
			"unconfigured",
			`配置里找不到 ${providerId}/${modelId ?? "(第一个模型)"}`,
		);
	}

	const apiKey = process.env.INNO_API_KEY || provider.apiKey;
	if (!apiKey || apiKey === "replace-me") {
		throw new PolishUnavailable(
			"unconfigured",
			`模型配置里的 apiKey 还是占位值（${found.path}）。填入真实 key，或设置环境变量 INNO_API_KEY。`,
		);
	}

	return {
		providerId,
		modelId: model.id,
		provider: { ...provider, apiKey },
		model,
		configPath: found.path,
		configFrom: found.from,
		keyFrom: process.env.INNO_API_KEY ? "环境变量 INNO_API_KEY" : "配置文件",
	};
}

/** 给设置面板用：列出可选的 provider / model，绝不外泄 apiKey */
export async function describeModelConfig(root) {
	const found = await findModelConfig(root);
	const cfg = found.raw;
	const providers = Object.entries(cfg.providers ?? {}).map(([id, p]) => ({
		providerId: id,
		baseUrl: p.baseUrl,
		hasKey: Boolean(process.env.INNO_API_KEY || (p.apiKey && p.apiKey !== "replace-me")),
		models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name })),
	}));
	return {
		configPath: found.path,
		configFrom: found.from,
		defaultProvider: cfg.defaultProvider,
		defaultModel: cfg.defaultModel,
		keyFromEnv: Boolean(process.env.INNO_API_KEY),
		providers,
	};
}

/* ---------------- 隔离会话 ---------------- */

async function loadSdk() {
	try {
		return await import("@earendil-works/pi-coding-agent");
	} catch (err) {
		throw new PolishUnavailable(
			"unconfigured",
			`没有装上 @earendil-works/pi-coding-agent（${err.code ?? err.message}）。在 最小闭环原型/ 下执行 npm install。`,
		);
	}
}

// 每次润色建一个全新会话，用完即 dispose：
// 隔离的意义就在这里——本次润色看不到上一次的内容，也看不到主代理的任何东西
async function createIsolatedSession(root, cfg) {
	const {
		createAgentSessionFromServices,
		createAgentSessionServices,
		SessionManager,
		SettingsManager,
	} = await loadSdk();

	const agentDir = join(root, ".polish-agent");
	const settingsManager = SettingsManager.create(root, agentDir);
	const services = await createAgentSessionServices({
		cwd: root,
		agentDir,
		settingsManager,
		// 不加载宿主的扩展、技能、提示词模板、主题、上下文文件
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt:
				"Isolated Inno prose-polishing session. No tools or host memory are available. " +
				"You rewrite a single passage of the user's own notes for clarity and fluency.",
		},
	});

	services.modelRegistry.registerProvider(cfg.providerId, {
		baseUrl: cfg.provider.baseUrl,
		apiKey: cfg.provider.apiKey,
		api: cfg.provider.api ?? "openai-completions",
		...(cfg.provider.headers ? { headers: { ...cfg.provider.headers } } : {}),
		...(typeof cfg.provider.authHeader === "boolean" ? { authHeader: cfg.provider.authHeader } : {}),
		models: [
			{
				id: cfg.model.id,
				name: cfg.model.name,
				reasoning: cfg.model.reasoning ?? false,
				input: [...(cfg.model.input ?? ["text"])],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: cfg.model.contextWindow,
				maxTokens: cfg.model.maxTokens,
				compat: { supportsDeveloperRole: false },
			},
		],
	});
	services.modelRegistry.refresh();

	const model = services.modelRegistry.find(cfg.providerId, cfg.modelId);
	if (model === undefined) {
		throw new PolishUnavailable("unavailable", "注册后仍然找不到配置的模型");
	}

	const created = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(), // 一次性会话，不落盘、不可恢复
		model,
		noTools: "all",
	});

	// 上游的兜底断言原样保留：真出现配置漂移就失败，而不是静默放行一个带工具的会话
	const tools = created.session.getActiveToolNames();
	if (tools.length !== 0) {
		created.session.dispose();
		throw new PolishUnavailable("unavailable", `隔离会话竟然暴露了工具：${tools.join(", ")}`);
	}

	return created.session;
}

/* ---------------- 取回子代理的回答 ---------------- */

/**
 * 跑一轮并取回文本。
 *
 * 关键点：调用失败时 `getLastAssistantText()` 返回 undefined，但**真正的原因**
 * 躺在最后一条 assistant 消息的 `stopReason` / `errorMessage` 里。不去捞它，
 * 用户看到的就永远是一句没用的「子代理没有返回内容」——上游 401、额度用尽、
 * 模型名写错，全都长一个样。所以这里把真实错误捞出来原样往上报。
 */
async function runOnce(session, prompt) {
	await session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });

	const text = session.getLastAssistantText();
	if (text !== undefined && text.trim().length > 0) return text;

	const last = [...(session.messages ?? [])].reverse().find((m) => m?.role === "assistant");
	if (last?.errorMessage) {
		// 401 / 403 是配置问题，不是临时故障——分开报，用户才知道该去改什么
		const authish = /\b(401|403)\b|api key|authenticat|unauthor/i.test(last.errorMessage);
		throw new PolishUnavailable(
			authish ? "unconfigured" : "unavailable",
			`模型调用失败：${last.errorMessage}`,
		);
	}
	if (last?.stopReason && last.stopReason !== "end_turn") {
		throw new PolishUnavailable("unavailable", `模型中断于 ${last.stopReason}，没有产出内容`);
	}
	throw new PolishUnavailable("unavailable", "子代理没有返回内容");
}

/* ---------------- 润色 ---------------- */

const MAX_CHARS = 4000;

function buildPrompt(text, instruction) {
	const want = instruction?.trim()
		? `用户对这次改写的要求：${instruction.trim()}`
		: "默认要求：让它更通顺、更好读。";
	return [
		"下面三条横线之间是用户笔记里的一段话。请把它改写得更好。",
		"",
		"规则：",
		"1. 只输出改写后的正文本身，不要解释、不要前后缀、不要代码围栏。",
		"2. 保持原意，不要新增原文没有的事实、数据、结论。",
		"3. 原样保留其中的 Markdown 记号：# 标题、1. 序号、- 要点、`行内代码`、[[页面链接]]。",
		"4. 保持与原文相同的语言。",
		"",
		want,
		"",
		"---",
		text,
		"---",
	].join("\n");
}

// 模型偶尔会不听话地裹一层代码围栏，剥掉它
function stripFence(s) {
	const m = /^```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(s.trim());
	return (m ? m[1] : s).trim();
}

export async function polish({ root, text, instruction, pick }) {
	if (typeof text !== "string" || !text.trim()) {
		throw new PolishUnavailable("unavailable", "没有选中任何文字");
	}
	if (text.length > MAX_CHARS) {
		throw new PolishUnavailable(
			"unavailable",
			`选中了 ${text.length} 个字，超过单次润色上限 ${MAX_CHARS}。请分段选。`,
		);
	}

	const cfg = await loadModelConfig(root, pick);
	const session = await createIsolatedSession(root, cfg);
	try {
		const out = await runOnce(session, buildPrompt(text, instruction));
		return {
			suggestion: stripFence(out),
			model: { providerId: cfg.providerId, modelId: cfg.modelId },
			// 如实回报隔离状态，供界面展示——不是装饰，是红线 1 的可核验证据
			isolation: { tools: 0, session: "ephemeral", sharesMainContext: false },
		};
	} finally {
		session.dispose();
	}
}

/* ---------------- 从冻结来源编译 concept 页草稿（S-C 最小版） ---------------- */

const MAX_SOURCE_CHARS = 60000;

// 结构化输出的口径和上游 PiStructuredModelAdapter 一致：
// 要求返回恰好一个 JSON 值，允许一层 json 围栏
function buildCompilePrompt(sourceText, topic, instruction) {
	return [
		"你在把一份学习资料整理成一个知识库页面。资料在最后的三条横线之间。",
		"",
		topic?.trim() ? `本页要讲的主题：${topic.trim()}` : "自己从资料里挑出最值得单独成页的一个主题。",
		instruction?.trim() ? `用户的额外要求：${instruction.trim()}` : "",
		"",
		"只返回一个 JSON 值，不要解释，不要多余的文字：",
		"{",
		'  "title": "页面标题，一个名词短语",',
		'  "summary": "两三句话说清这是什么",',
		'  "tags": ["3 到 6 个标签"],',
		'  "facts": [{ "text": "写进页面的一句话", "quote": "资料里对应的原文" }],',
		'  "links": ["可能相关的其他页面名，没有就给空数组"]',
		"}",
		"",
		"关于 quote，这是最重要的一条：",
		"- 它必须是资料里**一字不差**照抄下来的连续片段，不许改写、不许拼接、不许省略中间部分；",
		"- **连符号一起抄**：原文里的 [[双链]]、**加粗**、行首的 - 和 1.、冒号括号，一个都不要省。",
		"  实测最常见的失败就是抄的时候把 [[ ]] 去掉了，那样就对不上；",
		"- 你写的每一条 text 都必须能被它对应的 quote 支持；",
		"- 系统会逐条拿 quote 去原文里做子串比对，**对不上的会被拦下来，不会进入页面**；",
		"- 因此宁可少写几条、也不要为了凑数编 quote。资料里没有的内容就不要写。",
		"- quote 不要超过 500 字。",
		"",
		"---",
		sourceText,
		"---",
	].filter(Boolean).join("\n");
}

function parseJsonValue(text) {
	const trimmed = stripFence(text);
	try {
		return JSON.parse(trimmed);
	} catch {
		// 模型有时会在 JSON 前后带一句话，退而求其次截取最外层大括号
		const a = trimmed.indexOf("{"), b = trimmed.lastIndexOf("}");
		if (a !== -1 && b > a) {
			try {
				return JSON.parse(trimmed.slice(a, b + 1));
			} catch { /* 落到下面统一报错 */ }
		}
		throw new PolishUnavailable("unavailable", "子代理没有返回可解析的 JSON");
	}
}

const strArray = (v) =>
	Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];

export async function compileConcept({ root, sourceText, topic, instruction, pick }) {
	if (typeof sourceText !== "string" || !sourceText.trim()) {
		throw new PolishUnavailable("unavailable", "来源是空的");
	}
	if (sourceText.length > MAX_SOURCE_CHARS) {
		throw new PolishUnavailable(
			"unavailable",
			`来源 ${sourceText.length} 字，超过单次编译上限 ${MAX_SOURCE_CHARS}`,
		);
	}

	const cfg = await loadModelConfig(root, pick);
	const session = await createIsolatedSession(root, cfg);
	try {
		const out = await runOnce(session, buildCompilePrompt(sourceText, topic, instruction));
		const raw = parseJsonValue(out);
		return {
			draft: {
				title: String(raw?.title ?? "").trim(),
				summary: String(raw?.summary ?? "").trim(),
				tags: strArray(raw?.tags),
				links: strArray(raw?.links),
				facts: Array.isArray(raw?.facts) ? raw.facts : [],
			},
			model: { providerId: cfg.providerId, modelId: cfg.modelId },
			isolation: { tools: 0, session: "ephemeral", sharesMainContext: false },
		};
	} finally {
		session.dispose();
	}
}
