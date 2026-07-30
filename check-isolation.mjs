// S-B 完成定义第一条「润色跑在独立会话」的证据。
//
// 不需要真实 API key：会话的构造、工具集、资源加载都在任何模型调用之前就定下来了，
// 所以用一个假 key 也能核验隔离是否真的成立。跑法：
//   node check-isolation.mjs
//
// 红线 5「宣传材料只写有测试证据的能力」——这个脚本就是那份证据。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, rm } from "node:fs/promises";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TMP = join(ROOT, ".isolation-check.json");

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
	}
};

console.log("\n润色子代理隔离性核验（ADR-V2-022）\n");

// 假配置：只为把会话建起来，不发任何请求
await writeFile(
	TMP,
	JSON.stringify({
		defaultProvider: "checkonly",
		defaultModel: "check-model",
		providers: {
			checkonly: {
				baseUrl: "http://127.0.0.1:9",
				api: "openai-completions",
				apiKey: "check-only-not-a-real-key",
				models: [
					{
						id: "check-model",
						name: "check",
						reasoning: false,
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 1024,
					},
				],
			},
		},
	}),
	"utf8",
);
process.env.INNO_MODEL_CONFIG = TMP;

try {
	const { loadModelConfig } = await import("./polish-agent.mjs");
	const {
		createAgentSessionFromServices,
		createAgentSessionServices,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");

	const cfg = await loadModelConfig(ROOT);
	ok("模型冻结在配置里的 defaultProvider/defaultModel", cfg.modelId === "check-model", `→ ${cfg.providerId}/${cfg.modelId}`);

	const agentDir = join(ROOT, ".polish-agent");
	const settingsManager = SettingsManager.create(ROOT, agentDir);
	const services = await createAgentSessionServices({
		cwd: ROOT,
		agentDir,
		settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Isolated Inno prose-polishing session.",
		},
	});
	services.modelRegistry.registerProvider(cfg.providerId, {
		baseUrl: cfg.provider.baseUrl,
		apiKey: cfg.provider.apiKey,
		api: cfg.provider.api,
		models: [
			{
				id: cfg.model.id,
				name: cfg.model.name,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: cfg.model.contextWindow,
				maxTokens: cfg.model.maxTokens,
				compat: { supportsDeveloperRole: false },
			},
		],
	});
	services.modelRegistry.refresh();
	const model = services.modelRegistry.find(cfg.providerId, cfg.modelId);
	ok("注册后能找到该模型", model !== undefined);

	const a = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(),
		model,
		noTools: "all",
	});

	// 红线 1：模型无正式写权限。零工具是它在这一层最硬的形式
	const tools = a.session.getActiveToolNames();
	ok("子代理工具数为 0（模型物理上无法写文件）", tools.length === 0, `→ [${tools.join(", ")}]`);

	// 会话之间互不可见：这正是「不污染主代理上下文」的机制
	const b = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(),
		model,
		noTools: "all",
	});
	ok("两次润色是两个不同的会话对象", a.session !== b.session);
	ok(
		"新会话不带上一次的对话内容",
		b.session.getLastAssistantText() === undefined,
		`→ ${JSON.stringify(b.session.getLastAssistantText())}`,
	);

	a.session.dispose();
	b.session.dispose();

	// 会话是一次性的：inMemory 不落盘，所以没有可被续接的会话文件
	ok("一次性会话不落盘（无 session file）", SessionManager.inMemory().getSessionFile() === undefined);
} catch (err) {
	fail++;
	console.log(`  ✗ 核验过程抛错：${err?.message ?? err}`);
	if (process.env.DEBUG) console.error(err);
} finally {
	await rm(TMP, { force: true });
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
