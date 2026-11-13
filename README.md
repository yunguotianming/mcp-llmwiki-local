# llmwiki-local

llmwiki-local 是独立运行的本地 stdio MCP 服务，让 Codex 等客户端查询 Markdown 知识库、生成预览、确认发布，以及复制已有库并更换向量模型。无需安装 dsh。

代码复制自 `<个人资料目录>\ai-projects\deepseek-harness\plugins\self-developed\dsh-llmwiki` 的 v0.2.0 合并分支提交 **ff449031f899b53bc3342adae89008e536a69c26**（简称 ff44903）。本仓库版本为 **0.2.0**，独立安装、独立维护；共用核心保持该提交字节一致，适配层负责配置、模型调用与 MCP。来源也记录在 package.json，许可与第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 1. 安装与启动

需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。本机验证使用 Node.js 24。执行：

```powershell
Set-Location '<个人资料目录>\ai-projects\llm-wiki\mcp-llmwiki-local'
pnpm install --frozen-lockfile
pnpm run build
node dist/cli.js library add '<资料库目录>' --name '我的资料'
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

密钥只通过进程环境变量传入，不填入 JSON、工具参数或 README 示例。Codex CLI 沿用本机登录；本项目测试不调用真实模型。

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
| `wiki_generate` | `libraryId`，可选 action=scan/generate、legacyLibraryAction=backup、reextract=all/gaps/来源 ID 数组；立即返回 jobId |
| `wiki_status` | `jobId`；返回进度、缺口、模型调用与 token 成本；includePreview=true 返回逐页变更和 digest |
| `wiki_commit` | 携带 jobId 与已读预览的 digest，核对版本、策略和资料后发布 |
| `wiki_cancel` | 按 jobId 取消后台任务或预览，已发布版本不回滚 |
| `wiki_copy_with_embedding` | `libraryId`、confirm=true、target；复制后只重算向量，立即返回 jobId |

生成流程：登记资料 → wiki_generate → 轮询 wiki_status → includePreview=true 阅读变更 → 携带 digest 调用 wiki_commit。取消运行任务后应轮询到终态。服务重启会把失去运行进程的任务标为 interrupted；再次生成复用核心持久检查点。完成预览的 jobId 和 digest 可在重启后继续使用。

提取调用因连接、超时、上游流中断、HTTP 429 或 5xx 耗尽重试时，组级缺口标为可重试，普通建库及续跑会自动重提。其他 4xx 按状态码判为永久缺口；内容校验失败的组级缺口保留，可用 `reextract=gaps` 显式重试。旧缺口没有标记时按原因文本识别。

复制 target 选择 `embeddingMode=ollama` 并提供 `localEmbeddingModel`（可选 `localEmbeddingUrl`），或选择 cloud 并提供 `cloudEmbeddingModel`、`cloudEmbeddingUrl`、`cloudEmbeddingKeyEnv`。目标目录存在时拒绝覆盖，完成后自动登记副本；该工具不走预览提交。

## 5. 库布局与兼容

新库默认写在资料目录下 `.llmwiki-qwen3-06b`，其他模型形如 `.llmwiki-qwen3-8b`。根目录保留 `wiki/`、`library.yaml`、`README.md`，内部数据存放 `data/` 并由 `data/layout.json` 标记。旧 `.llmwiki/` 布局沿用；遇到旧式 Wiki 需要转换时，只在显式 `legacyLibraryAction=backup` 后备份处理。

资料目录内只有一个模型库时自动登记它；多个模型库时直接传入目标库目录。dsh 与本服务使用相同设备身份、写锁和版本协议：后来的写操作返回正在被占用；并发读写、撤权过滤及人工修改冲突检查沿用核心。

独立 MCP 开放本地 Markdown 建库。思源导出、Obsidian 共管、旧式生成与维护代码因核心依赖保留，但没有新增对应的远端登记、宿主附件、自动维护或 keeper 入口；相关宿主能力不在本次工具范围。`wiki_source_read`、`wiki_create`、旧 `wiki_changes` 由本次工具与 library 命令分工替代，不作为同名工具注册。错误中可能保留上游“设置页/宿主”等文字，其处理逻辑未改。

## 6. 验证与同步

```powershell
pnpm run typecheck
pnpm run build
pnpm test
```

测试入口每批最多运行五个实际用例，日志与统计写入系统临时目录。迁入测试的允许基线失败及最终结果见 [首次迁移验证](docs/06-验收与测试/02-首次迁移验证.md)；固定提交对照见 [源仓库文件对照](docs/06-验收与测试/01-源仓库文件对照.md)。同步规则见 [AGENTS.md](AGENTS.md)。

## 许可证与测试夹具

本项目采用 [MIT 许可证](LICENSE)。改编自 obsidian-llm-wiki 的部分保留 Apache-2.0 声明，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

含第三方论文原文的十一个测试夹具未随公开仓库发布，路径列在 `.gitignore`。依赖这些夹具的用例在文件缺失时跳过，测试结果显示原因；其余用例照常执行。参数化用例保留原有编号和数量。`topic-sentence-context.ts` 与 `v011-published.json` 为合成样例，保留并继续测试。历史中的个人路径及内联真实摘录已脱敏。
