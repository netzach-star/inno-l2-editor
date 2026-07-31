# inno-l2-editor

给 [InnoSpark](https://github.com/hhyqhh/inno-agent) 的 **L2 Wiki 知识库**补一套更好的写入体验：
**AI 负责整理，用户负责决定。**

![编辑器主界面](docs/images/editor-main.png)

---

## 解决什么问题

L2 知识库是一堆 Markdown 文件。往里写东西原本只有两条路：

- **让主代理写** —— 改一处要绕几轮对话，还**挤占主代理的上下文**
- **自己改 md** —— 面对没渲染的源码，得懂语法、自己维护 `[[关联]]`

这个项目补中间那一层：**渲染层 + 结构化编辑**，AI 的活挪进独立子代理。

## 三件事

**① 结构化编辑，不碰 YAML。** tag 和「相关知识」点着改，加关联自动双向写入。
md **始终可手改** —— 系统只托管 frontmatter 的 `tags` 和正文里 `## 相关知识` 一段，
其余一个字节都不动。你在 Obsidian 里改完回来，以文件为准。

**② 润色跑在独立会话，工具数为 0。** 它物理上写不了文件，只能提建议；
采用之前正文一个字不变，也不占主代理上下文。

**③ 从资料生成新页，每条都要对得上原文。** 资料先**冻结**（内容寻址 + hash），
子代理产出的每条都附一句原文引文，服务端逐条核对是不是**精确子串**——

![引文核对](docs/images/editor-review.png)

核不上的**标红拦下、留在界面上**，不会被悄悄删掉。这是为了回答一个很实际的问题：
**「这条到底是不是它编的？」**

---

## 安装

```bash
git clone https://github.com/netzach-star/inno-l2-editor.git
cd inno-l2-editor
npm install
```

```bash
INNO_AGENT_DIR=/path/to/inno-agent node server.mjs
```

打开 http://localhost:4321 。

`INNO_AGENT_DIR` 指向 InnoSpark 安装目录（有 `restart-dev.sh` 的那一层）。指对了，
编辑的就是它的真实 L2，模型配置也和主代理**同一份**（两边各读各的会出现主代理 401
而这边显示「已配置」的怪事，踩过一次）。

不设也能跑，此时编辑仓库自带的三页示例，左上角橙色标明「非真实库」。

## 装上「对话寄存区」

不装的话，把对话变成 wiki 页只能手动复制粘贴。装上之后 —— 每段 AI 回答下方多一个按钮：

![加入寄存区](docs/images/innospark-stage-button.png)

攒够了在右侧「寄存区」点「开始总结」，自动送到编辑器开始生成：

![寄存区](docs/images/innospark-staging-panel.png)

```bash
./bridge/install.sh /path/to/inno-agent
cd /path/to/inno-agent && ./restart-dev.sh restart --mode prod
```

卸载：`./bridge/install.sh /path/to/inno-agent --uninstall`

脚本**幂等**（装过会跳过）、**可逆**（卸载后 `git status` 逐字节干净）、**不硬来**
（所有改动先算完，任一锚点对不上就中止、一个字节都不写，并指明是哪个文件哪段）。
改动量压到最小：新增 2 个文件、改动 5 个。InnoSpark 侧只负责攒和交，
编译、核对、落盘全在这边。

---

## 怎么用

**从对话攒素材** —— 回答下方点「加入寄存区」，该回答连同对应提问一起存下，
以提问前 20 字为题。

**编辑已有页面** —— 左侧选页，右侧改 tag 和「相关知识」，「保存并写回 md」。
正文里手写的 `[[wikilink]]` 也算正式关联，面板中虚线框回显；要删请到正文里删——
系统不替你改写自己的句子。

**让 AI 润色** —— 编辑态选中一段，按钮或 `⌘K`，看建议后「采用」或「放弃」。

**从资料生成新页** —— 左上「＋ 从资料生成新页」，传 `.md`/`.txt` 或粘贴 AI 的几轮回答，
核对每一条后勾选落盘。

## 核验

```bash
node check-citation.mjs    # 25 项：引文校验与来源冻结
node check-isolation.mjs   #  6 项：子代理隔离
node check-pipeline.mjs    # 27 项：写盘边界（需先启动 server.mjs）
```

都不需要 API key。钉住四条：模型没有正式写权限；引文必须是冻结来源的精确子串；
界面可以撒谎、服务端不信（写盘那侧重新核对）；冻结对账在引文校验**之前**。

## 环境变量

| 变量 | 作用 |
|---|---|
| `INNO_AGENT_DIR` | InnoSpark 安装目录（推荐，一个顶下面三个） |
| `INNO_WIKI_DIR` | 单独指定 wiki 目录 |
| `INNO_MODEL_CONFIG` | 单独指定模型配置文件 |
| `INNO_API_KEY` | 覆盖配置里的 key，不落任何文件 |
| `INNO_SOURCES_DIR` | 冻结来源存放位置，默认 `./data/sources` |

没装 InnoSpark 又想用 AI：`cp model.config.example.json model.config.json`，填进 apiKey。

## 目录

| | |
|---|---|
| `server.mjs` | HTTP、md 读写、链接解析、图谱构建 |
| `index.html` | 全部前端（无框架、无构建） |
| `polish-agent.mjs` | 子代理：隔离会话、润色、从来源编译 |
| `citation.mjs` | 引文校验 |
| `source-store.mjs` | 来源冻结，内容寻址 + hash 对账 |
| `bridge/` | 对话寄存区：装进 InnoSpark 的脚本与源码 |
| `sample/wiki/` | 三页示例（自撰常识，不取自任何教材） |

## 和 InnoSpark 的关系

刻意独立：独立进程、独立端口，视图层另写一套而不复用它的组件。代价是有重复，
收益是它内部结构变了这边不用跟着改 —— 耦合面只有两处：**来源摄入**与**读写 L2**。

上游行为一律以其源码为准。链接解析与图谱构建移植自 `wiki-links.ts` / `wiki-graph.ts`，
引文规范化移植自 `canonical.ts`，两边不各写一套。

> 一处有意的偏离：引文规范化多了「去掉两个中日韩字符之间的空白」。上游那套为空格分词
> 语言设计，中文在句子中间换行会多出一个空格，导致**合法引用**匹配失败。该步骤只动空白、
> 不删实体字符，跨段拼接照样拦得住（`check-citation.mjs` 有断言）。

## 已知边界

不做：Git 式三方合并、多用户实时协作、任意 Markdown 全量反向解析、语义关系类型与方向、
学习路径推理、图谱画布编辑、PDF 直接解析（当前支持 `.md` / `.txt`）。

数学公式不渲染 KaTeX —— InnoSpark 自带的笔记本视图渲染，这边还没补。

## 许可

[MIT](LICENSE)，与 InnoSpark 一致。`sample/wiki/` 下的示例为本项目自撰，同样适用 MIT。
你自己知识库里的内容归你，这个工具不对它主张任何权利。
