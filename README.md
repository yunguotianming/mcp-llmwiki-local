# llmwiki-local

llmwiki-local 是独立运行的本地 stdio MCP 服务，让 Codex 等客户端查询 Markdown 知识库、生成预览、确认发布，以及复制已有库并更换向量模型。无需安装 dsh。

代码最初复制自 dsh-llmwiki 的 `ff44903`，共享建库、存储和查询代码按固定提交同步，独立安装、独立维护。当前包版本为 **0.3.0-preview.1**，独立发布到 [mcp-llmwiki-local](https://github.com/yunguotianming/mcp-llmwiki-local)。先验证建库模块，再发布本仓预览版并补建三个库；查询回答继续完善，预览版不代表正式质量验收通过。实际同步提交和适配范围见[源仓库文件对照](docs/06-验收与测试/01-源仓库文件对照.md)，验收与发布状态见[项目进度](docs/00-项目进度/01-项目进度.md)。适配层负责配置、模型调用与 MCP；package.json 的 repository 记录本仓发布地址，source 记录同源插件的同步依据。许可与第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 1. 安装与启动

需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。本机验证使用 Node.js 24。执行：

```powershell
Set-Location '<个人资料目录>\ai-projects\llm-wiki\mcp-llmwiki-local'
pnpm install --frozen-lockfile
pnpm run build
node dist/cli.js library add 'E:\资料' --name '我的资料'
node dist/cli.js library list
node dist/cli.js mcp
```

安装为命令后同样可用 `llmwiki-local mcp`、`llmwiki-local library add <资料目录> [--name <名称>]`、`library list`、`library remove <id>`。remove 只删登记，不删文件。stdio 服务由客户端启动，stdout 只传协议，诊断日志写 stderr。

## 2. 配置与模型

首次启动自动生成 `~/.llmwiki-local/config.json`；设置 `LLMWIKI_LOCAL_HOME` 可更换配置目录。文件包含 `registry` 与 `runtime`，registry 沿用上游非宿主配置字段；`registry.libraries` 保存库名、绝对路径、模型与 layered/queryUnderstanding 设置。停止写任务后修改配置，MCP 每次请求重新读取登记；修改 runtime 后重启服务。

| 配置 | 默认值与用途 |
| --- | --- |
| `runtime.codexExecutable` | `codex`；Windows 自动查找 npm 安装的原生 codex.exe，也可填写绝对路径 |
| `runtime.codexContextWindowTokens` | 256000；沿用上游已跑通建库参考的保守预算，可按选用模型调整 |
| `runtime.deepseekBaseUrl` | `https://api.deepseek.com/v1`，OpenAI 兼容接口 |
| `libraries[].models.unified` | `codex-cli` / `gpt-6.1-terra`；五个建库阶段默认推理 high |
| `libraries[].queryUnderstanding` | 默认 `deepseek-official` / `deepseek-flash`；无调用方变体时辅助理解，失败保留原话 |
| `libraries[].layered.localEmbeddingUrl` | `http://127.0.0.1:11434` |
| `libraries[].layered.localEmbeddingModel` | `qwen3-embedding:0.6b` |
| `libraries[].layered.embeddingMode` | 默认 auto，亦支持 ollama、cloud、none；none 为纯全文 |

首次生成后随库策略在 `data/state/policy.json`（旧布局路径保持原样）；停止任务后可调整 `pageGenerationConcurrency` 和 `concurrencyLimit`，范围均为 1～1000，实际生成并发默认 3，不能超过上限；嵌入供应商闸门保持 50。模型路由和供应商重试、速率设置沿用核心配置校验。

云端向量需显式选择 cloud，并设置 `cloudEmbeddingUrl`、`cloudEmbeddingModel`、`cloudEmbeddingKeyEnv`；最后一项填写环境变量名。查询向量默认冷态等待 10 秒、就绪后等待 2 秒，可在登记的 layered 配置中设置 `queryEmbeddingColdTimeoutMs` 和 `queryEmbeddingTimeoutMs`；超时降级不写入一分钟失败缓存，Ollama 查询超时可触发共享后台预热。已有库的向量身份绑定在库内，更换模型使用复制工具。纯全文库仍可生成来源与索引，不调用嵌入；主题组织行为沿用上游全文模式。

| 可用内存 | Ollama 模型建议 |
| --- | --- |
| 8GB 以下 | `qwen3-embedding:0.6b` |
| 16GB 左右 | `qwen3-embedding:4b` |
| 32GB 以上 | `qwen3-embedding:8b` |

### 2.1 环境变量

| 名称 | 用途 |
| --- | --- |
| `LLMWIKI_LOCAL_HOME` | 配置和本地作业回执目录，默认 `~/.llmwiki-local` |
| `DEEPSEEK_API_KEY` | DeepSeek 官方查询理解密钥；缺失时返回降级标注 |
| `LLMWIKI_EMBEDDING_API_KEY` | 默认云端嵌入密钥变量；也可通过 `cloudEmbeddingKeyEnv` 指定其他变量 |
| `CODEX_HOME` | 由已安装 Codex CLI 读取其既有配置和登录状态；本服务不修改 |

兼容模型与嵌入服务支持在本机配置中填写 `apiKey`，或用 `apiKeyEnv` 引用进程环境变量，两者互斥。凭据不随库复制或导出，不写入工具参数、作业回执、模型提示词或日志。Codex CLI 沿用本机登录；自动化测试使用假模型，真实库只读联验单独记在[项目进度](docs/00-项目进度/01-项目进度.md)。

### 2.2 多模型与接受恢复

`registry.compatibleProviders` 可登记 `compatible:<名称>`，指定 `baseUrl`、`model`、`api`（`openai-completions` 或 `openai-responses`），凭据按上节选择一种方式；`registry.embeddingService` 使用同一凭据约定。配置文件仍使用原有 `{ registry, runtime }` 外层。两种协议沿用相同的模型路由和日志脱敏规则。

建库阶段策略、线路和并发配额分别来自库策略的 `buildModels` 与登记的 `modelExecution`。已接受成果、实际模型、生产记录和升级备份沿用共用核心；暂停后换模型续跑先复用已有成果。旧模型路由和 `runtime` 配置继续有效。

## 3. 在 Codex 登记 MCP

把以下示例手动合并到 `~/.codex/config.toml`。示例使用当前电脑 Node.js 与构建入口的绝对路径；换电脑时替换这两个路径。本仓库不会修改用户的 Codex 配置。

```toml
[mcp_servers.llmwiki-local]
command = 'C:\Program Files\nodejs\node.exe'
args = ['<个人资料目录>\ai-projects\llm-wiki\mcp-llmwiki-local\dist\cli.js', 'mcp']
env_vars = ['DEEPSEEK_API_KEY', 'LLMWIKI_EMBEDDING_API_KEY', 'LLMWIKI_LOCAL_HOME']
startup_timeout_sec = 30
tool_timeout_sec = 120
```

配置字段参考 [Codex MCP 文档](https://developers.openai.com/codex/mcp/)。修改后让客户端重新加载 MCP 服务。

## 4. 工具与操作

| 工具 | 用途 |
| --- | --- |
| `wiki_list_libraries` | 列出启用库与当前卡片、版本 |
| `wiki_search` | `query`、`library`、`types`、`variants`、`limit`、`include`、`excerpt_budget`、`excerpt_pages` 沿用上游 |
| `wiki_browse` | 按 root、主题、来源、章节下钻；cursor 分页 |
| `wiki_read` | 按路径或 ID 阅读，支持来源与已登记分节的 `#^块ID`，offset/maxChars 分页 |
| `wiki_generate` | `libraryId`，可选 action=scan/generate、retrySources、legacyLibraryAction=backup、reextract=all/gaps/来源 ID 数组；立即返回 jobId |
| `wiki_status` | `jobId`；返回进度、缺口、模型调用与 token 成本；includePreview=true 返回逐页变更和 digest |
| `wiki_commit` | 携带 jobId 与已读预览的 digest，核对版本、策略和资料后发布 |
| `wiki_cancel` | 按 jobId 取消后台任务或预览，已发布版本不回滚 |
| `wiki_copy_with_embedding` | `libraryId`、confirm=true、target；复制后只重算向量，立即返回 jobId |
| `wiki_find_library`、`wiki_library_card` | 按问题选库、读取库卡片；`wiki_list_libraries` 传 cursor/limit/groupId 时返回分页短目录 |
| `wiki_register_library`、`wiki_update_library`、`wiki_unregister_library` | 按 expectedRegistryRevision 登记、修改或移除库；移除保留文件，运行中禁止更改路径或移除登记 |
| `wiki_answer`、`wiki_source_read` | 按库或发现结果回答，按来源及定位读取原文；思源返回外部回源提示 |
| `wiki_changes`、`wiki_pause`、`wiki_retry_topic_gaps` | 按库检查预览批次、暂停运行和显式重试主题缺口 |

MCP 共 19 个工具。旧 `wiki_status(jobId)`、`wiki_commit`、`wiki_cancel` 和带 target 的异步复制接口保留；`wiki_status(libraryId)` 可读取生产记录，复制省略 target 时使用 `embeddingService`。库卡片还可通过 `llmwiki://libraries/{libraryId}/card` 资源读取和订阅。

`wiki_list_libraries` 返回的 `libraryId` 可直接作为 `wiki_search`、`wiki_browse`、`wiki_read` 和 `wiki_source_read` 的 `library`；库名输入继续可用，同名库建议使用 ID。页头格式损坏的页面会从搜索和浏览中隔离，并返回降级提示或 warning；其他来源页与原文仍可读取，直接读取坏页返回格式错误。

原 `library add/list/remove` 命令保持。新增 `libraries list/find/show/register/update/unregister`、`libraries groups list/save`、`libraries summary refresh/unlock`；请求使用 `--json <UTF-8 文件>` 或 `--json -`。命令沿用原配置目录、外层和写锁，修订冲突返回退出码 3。

生成流程：登记资料 → wiki_generate → 轮询 wiki_status → includePreview=true 阅读变更 → 携带 digest 调用 wiki_commit。取消运行任务后应轮询到终态。服务重启会把失去运行进程的任务标为 interrupted；再次生成复用核心持久检查点。完成预览的 jobId 和 digest 可在重启后继续使用。

提取调用因连接、超时、上游流中断、HTTP 429 或 5xx 耗尽重试时，组级缺口标为可重试，普通建库及续跑会自动重提。其他 4xx 按状态码判为永久缺口；内容校验失败的组级缺口保留，可用 `reextract=gaps` 显式重试。旧缺口没有标记时按原因文本识别。

只补指定已发布来源的摘要或核对缺口时，向 `wiki_generate` 传 `retrySources`：

```json
{
  "libraryId": "<libraryId>",
  "retrySources": { "sourceIds": ["S-0001"], "kinds": ["summary"] }
}
```

`sourceIds` 和 `kinds` 均须显式非空；`kinds` 可选 `summary`、`review`，也可同时选择。此操作要求可写的本地 Markdown 分层库，与扫描、重提和旧库备份互斥。摘要补缺复用原分组、配额和要点；没有有效匹配成员的组留下可审计的排除原因。核对只处理尚未核实的要点，沿用有界纠正；证据或可用状态真正改变时才更新已有依赖主题及必要父页。该生成范围不启动补标、术语、标签归并、旧待办聚类或嵌入；新核实但缺少主题归属或缓存向量的点继续保留待办及覆盖缺口。

暂停后再次生成可省略 `retrySources`，核心继续已保存的来源和种类；传入不同范围会被拒绝。补缺期间原资料集合须保持不变，新增、修改、删除或改名会在模型派发前暂停。完成后仍按上述作业流程阅读预览并提交。未在本轮重建的主题、术语等已有页面继续保留；同一范围没有剩余缺口时再次生成不会产生模型请求或新版本。

问答允许明确返回“本次证据不足”：模型引用数组和正文引用编号都为空时，服务端只返回固定提示，不交付模型的无引用正文。有依据的部分答案仍可返回，并说明其余缺口；引用编号一致不代表事实已被自动核实。引用 Wiki 页优先使用路径和块锚点，原文定位使用来源版本与 `#L`；搜索正文与补读全文的页头处理不同，不能直接把摘录的 `locator` 当作文件物理行号。

主题核对只有在正文、成员证据和协议均未变化，且已经取得明确完成结论时复用结果；协议或传输未完成会保留检查点，按有界额度续核或暂停。

复制 target 选择 `embeddingMode=ollama` 并提供 `localEmbeddingModel`（可选 `localEmbeddingUrl`），或选择 cloud 并提供 `cloudEmbeddingModel`、`cloudEmbeddingUrl`、`cloudEmbeddingKeyEnv`。目标目录存在时拒绝覆盖，完成后自动登记副本；该工具不走预览提交。

## 5. 库布局与兼容

新库默认写在资料目录下 `.llmwiki-qwen3-06b`，其他模型形如 `.llmwiki-qwen3-8b`。根目录保留 `wiki/`、`library.yaml`、`README.md`，内部数据存放 `data/` 并由 `data/layout.json` 标记。旧 `.llmwiki/` 布局沿用；遇到旧式 Wiki 需要转换时，只在显式 `legacyLibraryAction=backup` 后备份处理。

资料目录内只有一个模型库时自动登记它；多个模型库时直接传入目标库目录。dsh 与本服务使用相同设备身份、写锁和版本协议：后来的写操作返回正在被占用；并发读写、撤权过滤及人工修改冲突检查沿用核心。

独立 MCP 的异步生成入口开放本地 Markdown 建库，新增来源读取、库管理与批次操作使用共用服务。思源导出、Obsidian 共管、旧式生成与维护代码保留；宿主附件注入、自动维护、keeper 和 dsh 设置页不进入本服务。依赖 dsh 客户端产物与 HTTP 模块的本地网页工作区暂不同步，管理操作使用 CLI/MCP。错误中可能保留上游“设置页/宿主”等文字。

## 6. 验证与同步

```powershell
pnpm run typecheck
pnpm run build
pnpm test
```

测试入口每批最多运行五个实际用例，日志与统计写入系统临时目录。当前验收结果见 [项目进度](docs/00-项目进度/01-项目进度.md)，[首次迁移验证](docs/06-验收与测试/02-首次迁移验证.md)保留历史基线；固定提交对照见 [源仓库文件对照](docs/06-验收与测试/01-源仓库文件对照.md)。同步规则见 [AGENTS.md](AGENTS.md)。
