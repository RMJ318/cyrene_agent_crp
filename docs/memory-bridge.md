# CRP Memory Bridge v0.1 使用与验证

Bridge 为本地 1.3.7 定制版提供只读 CRP、Writer 现实个人记忆及现实 #0 作者层记忆。默认关闭，不迁移原记忆，不自动保存对话，不申请插件 LLM 能力或创建自动任务。

## 先在隔离资料目录试用

```powershell
pnpm install --frozen-lockfile
pnpm run dev:bridge
```

`dev:bridge` 先构建，再由显式开发开关启动独立 Electron 实例。启动入口在导入服务之前，为 appData、userData、sessionData 和 logs 创建新的临时资料目录；不会沿用原程序资料、旧版迁移来源或模型密钥。路径显示在终端中。每次启动创建新目录，退出后保留该目录供查看，不自动删除私人数据。

这条启动命令不填入模型地址或密钥，自动记忆关闭。可以先使用管理页的本地预览、CRUD 和备份功能，不必连接模型。不要把生产资料目录复制进开发资料目录。正式环境启用和云端模型调用需另行决定。

本次实现和测试没有运行这条 GUI 启动命令，也没有重启当前安装程序。

## 最少接入步骤

1. 在插件设置中启用内置 **CRP Memory Bridge**。
2. 打开 **记忆设置 → CRP Memory Bridge v0.1**，开启 Bridge。
3. 选择已有的 CRP 本地副本，或在 GitHub 仓库框输入 `owner/repository`（也支持 GitHub HTTPS 地址），点击 **从 GitHub 导入／更新**，等待快照校验完成。
4. 选择 RP、Writer 或作者层域，创建专用新会话。RP 人物视图必须填写人物 ID、现实、故事日及可选时刻；按日查询视为该日结束。
5. 本地预览不会调用对话模型。在真正对话前，界面会说明资料可能发送至会话当前配置的模型服务。

普通会话继续使用已有功能。专用 Bridge 会话保留本地状态、表情和贴纸处理，长期记忆仅来自当前范围；不注入未隔离的旧画像、世界书、关系日志、社交记忆或其他插件上下文。其工具列表只包含 Bridge 的只读工具，不授予任意文件、shell 或旧 wiki 记忆工具权限。

## 从 GitHub 只读导入

本机需安装 Git 并为私有仓库配置已有的 Git 凭证。Bridge 复用 Git 的凭证助手，不接收、保存或显示令牌；无法交互登录时会返回中文错误，请先在本机完成 Git 登录与授权。仓库框只接受 GitHub 仓库名或不含凭证的 HTTPS 地址。

每次点击获取默认分支的最新 HEAD，固定到完整 commit，再按现有白名单导出 `.md`、`.json` 原始字节并校验。不会 checkout、执行仓库脚本、推送或修改 CRP。页面显示对应仓库与 commit，重启后保留；再次点击即更新。失败或取消保持当前快照，可回滚上一快照及其来源信息。临时 Git 对象和导出目录在结束时清理，不后台同步，不调用付费模型。

导入后，在普通会话模型名右侧下拉菜单中勾选一个或多个现实，即开启对应现实的记忆召回。空选表示关闭；个人敏感记录仍遵循单独授权。

可复现检查（只使用虚构临时仓库和 Mock）：

```powershell
node node_modules/vitest/vitest.mjs run src/main/memory-bridge src/renderer/react/features/settings/MemoryBridgePanel.test.tsx src/renderer/react/features/chat/components/RealityMemorySelector.test.tsx
node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit
pnpm run build
```

Windows 上准备 Git 副本时，应关闭该副本的自动换行转换，保留源文件的原始字节；不要通过重写 raw、修改哈希或忽略校验来解决不一致。本实现需要本定制版的宿主隔离支持，不能仅把插件目录复制进原版 1.3.7 就获得完整边界。

切换现实、分支、人物或故事时点必须创建新会话。不能在原会话中将作者全知资料切换为人物知识。已停用会话保留隔离标记，继续禁止旧系统回填。

## 四个只读工具

### 普通会话的现实记忆下拉菜单

普通聊天输入栏的模型名右侧提供“现实记忆”下拉菜单。开启记忆设置中的 Bridge 并导入快照后，可勾选一个或多个现实；不必创建专用会话或启用查询插件。菜单只列出快照中实际存在的现实，现实 #0 标为作者层；Writer 的敏感个人记录不通过这个开关绕过单轮授权。

勾选项按会话持久化，欢迎页的选择会带入紧接着创建的新会话。每轮按当前问题使用本地 BM25 检索所选现实，合并结果共享预算，并保留各自现实编号、证据等级和来源。多现实结果只作为桌面作者查档参考，不转化为任一 RP 人物的亲身经历或跨现实知识。普通会话原有上下文和工具仍可使用；专用工具的可选本地语义路径保持原样。

取消勾选或“全部关闭”后不再召回相应现实。已经实际召回过资料时，变更勾选会从当前输入建立新模型上下文分段，避免旧召回资料从历史回复中继续进入模型；本地完整聊天记录保持原样。模型运行中菜单暂不允许修改勾选。

使用过该入口的会话会暂停旧的自动记忆提取、历史回填和自动关系记录，避免将 RP 或作者层事实写成现实个人记忆；其他普通会话不受影响。这个保护在清空勾选后保留。已有 CRP 资料的会话也不会自动传给外部渠道或其他插件读取。

| 工具 | 用途 |
|---|---|
| `crp-memory-bridge_search_memories` | 检索当前范围的证据与已授权个人记录 |
| `crp-memory-bridge_get_memory` | 根据稳定引用获取详情，原文/文稿支持 offset 分页 |
| `crp-memory-bridge_get_character_context` | 仅在已绑定人物视图中获取有效知识 |
| `crp-memory-bridge_get_writer_context` | 仅获取 Writer 域用户确认且本轮授权的记录 |

参数不能改变会话的现实、人物或权限。CRP 引用使用 `类型:原稳定ID`，如 `events:<原ID>`、`work_version:<原version_id>`；证据引用保留原 evidence_id。读取 ID 也会重新检查权限。

结果区分来源保真、发生审阅、完整审计和主张/信念状态。工具结果整体按现有本地 token 估算器限制在约 2000 tokens；截断显式标记，文稿的 `nextOffset` 使用 Unicode 字符位置。估算不是厂商实际计费 token 数。

人物取得记录若只登记自然语言限定范围，返回该范围的原登记文本，不把档案目标的完整描述当作人物已知。缺少可解释范围时不释放目标内容；只有明确的完整目标范围或具体版本全文取得才提供相应正文。

### 关键词与可选本地语义

默认复用 Cyrene 分词和 BM25，不调用 Embedding API。已经安装本地 BGE-M3 时，可以在管理页显式开启本地语义；使用 `createLocalEmbeddingProvider("bgem3")`，不读取可能指向云端的全局 provider。

权限过滤先于 Embedding。每次最多处理 200 个授权候选，向量只放入有界内存缓存，切换快照、权限或停用时清除。模型缺失时拒绝开启，运行失败时退回 BM25，不下载模型、不切换云端，不进行生成式改写。相似度不升级证据等级。

本地模型执行过程中取消会阻止结果释放；底层本地推理可能要完成当前计算批次才能退出。真实 BGE-M3 运行未在本次测试中启用，语义路径使用 Mock 验证。

## 原文待归档的连续性记录

快照同时保留 continuity 文件，但不会仅凭 Markdown 摘要猜测现实、时间、知识取得或原文审计状态。

管理页的“显式审核映射”可列出快照中的 continuity 文件。用户核对后填写有界摘要，并确认当前填写的现实、分支、发生/取得时点及人物权限。人物视图的映射只授权该人物。映射始终标为 `CONTINUITY_SUMMARY_RAW_PENDING` 和 `NOT_REVIEWED`，不伪造原文 evidence_id 或审计 PASS。

更新快照后，旧映射停止生效，需要重新审核；回滚到旧快照可恢复该旧版本的映射。映射只存于 Bridge 配置，不修改 CRP 文件。

需要纠正映射时，将本地预览中的 `continuity:...` ID 填入“撤销映射”，确认后重新审核保存。配置达到大小上限会拒绝新写入并保留原配置，可先撤销不再需要的旧映射；不会写出重启后无法读取的超限配置。

## Writer 与作者层记忆

在管理页切换到 Writer 或作者层后，点击读取本地记录。新增、修改、历史版本查看、可恢复删除、永久删除、导出及备份均为明确用户动作，模型没有写入工具。

- Writer 使用现实 #-1，作者层使用 #0；分别保存于独立 SQLite 数据库。
- 敏感内容默认勾选加密，使用 Electron safeStorage 的系统保护逐条保存；安全存储不可用时拒绝敏感写入，不降级为明文。普通记录为本地明文，应使用 Windows 账户/磁盘保护。
- 每次更新增加版本，使用 expectedRevision 防止覆盖并发修改，同时撤销原授权。编辑一个旧版本的内容并确认更新，可将其恢复为新的当前版本。
- 数据库为空或未授权时返回 unknown，不从 RP 补造现实生活事实。
- CRP 的 OOC 资料在作者层只标为档案参考，不声称是桌面角色的亲身经历。未来提案、信念与原始记录按现有元数据保留差别。

### 模型读取授权

选择专用会话后，界面显示实际模型及服务来源。点击“授权下一轮模型读取”并确认，授权绑定记录版本、会话、模型/服务/账户配置摘要，10 分钟内可被下一次实际查询使用。第一次查询将授权绑定到 runId；其他 run 不能复用。

切换模型、修改记录、撤销或恢复数据库后必须重新授权。界面显示与实际模型目标不一致时，宿主拒绝授权，需重新选择会话刷新目标。

授权改变或个人记忆已经向某一轮释放后，下一轮模型上下文会从新输入开始一个新分段，避免把旧工具结果及其派生回复继续发给模型。重启也会重新建立上下文边界；完整本地聊天记录保持原样，仍可在界面查看。跨分段的长期连续性来自显式保存并授权的记忆。

撤销不能收回已经发给模型服务的内容，也不删除本地聊天记录中用户此前主动输入的文字。不要把本地检索理解为所有资料永不外发。

## 快照与数据目录

运行时目录位于当前资料目录下的 `crp-memory-bridge/`：

```text
config.json                 # 默认关闭、当前/上一快照、用户审核映射
bridge-policy.json          # 专用会话范围与永久隔离标记
snapshots/<UUID>/           # 固定来源副本与 SHA256 清单
stores/writer.sqlite        # 初始 Writer 库
stores/reality0.sqlite      # 初始作者层库
stores/<UUID>.sqlite        # 备份恢复后的新库
backups/<domain>/<UUID>/    # 一致 SQLite 快照与校验清单
```

无密钥配置样例：[`examples/memory-bridge/config.example.json`](../examples/memory-bridge/config.example.json)。无需手改配置，推荐使用管理页。不要将此运行时目录放入 CRP、代码仓库、可写 Obsidian Vault 或公开同步目录。

导入只复制 library、raw、inbox、continuity、manuscripts 和 canon 下允许的 Markdown/JSON。单文件最多 32 MiB、快照最多 512 MiB/10000 个文件；不复制或执行 Python、插件、shell、Git hook 等代码。拒绝目录逃逸、符号链接/junction、未完成 CRP 事务、哈希不符及不支持的 schema。导入失败或取消保留旧 active snapshot；不会调用 CRP recover。

用户选择来源后才导入，不自动 git pull、不自动联网同步。快照代表该次导入的已校验版本，不代表 CRP 永远最新；需要时手动更新或回滚。

## 导出、备份与恢复

“本地导出预览”显示 JSON，可由用户复制保存；含敏感信息时需再次确认。它不会自动写入外部文件或上传。

“建立备份”使用 SQLite `VACUUM INTO` 建立一致备份，显示备份 ID。输入 ID 后“恢复到新库并预览”，核对后才“确认使用预览的新库”。旧库保留，所有已恢复授权清除，不自动覆盖当前库。

备份包含敏感记录的密文，依赖原系统账户的 safeStorage 解密能力；本版未提供跨机器密钥迁移。可恢复删除仍保留历史版本；永久删除清理当前库内该记录的所有版本和授权，但旧备份、旧恢复库和聊天记录可能仍有副本，需用户分别清理。不承诺文件系统级的物理擦除。

## 回滚

先在记忆设置停用 Bridge，再在插件设置禁用插件。进行中的查询会被取消，工具和动态 Provider 被注销。数据和备份保留；专用会话隔离标记继续生效。

已有普通会话及原记忆不迁移、不重分类。需要恢复旧应用代码时不要删除 `bridge-policy.json` 后再让旧系统批量回填新会话。正式生产回滚应保留这些会话或使用完全独立的资料目录。

## 开发检查

```powershell
pnpm exec vitest run src/main/memory-bridge src/main/orchestrator/build-options.test.ts src/renderer/react/features/settings/MemoryBridgePanel.test.tsx
pnpm run check:main
pnpm run check:preload
pnpm run check:renderer
pnpm run build
pnpm exec vitest run --testTimeout=30000
```

新增测试只用虚构档案、临时 SQLite 和 Mock；覆盖 A–G 所要求的现实/人物/时间边界、未知、版本更新、精确删除、重启恢复、备份损坏和来源不变，并验证 preload→IPC→管理服务、直接工具调用、队列/回填隔离、授权撤销、Unicode 引用与 UI 操作边界。

这不等于私人 CRP 的真实验收。尚未选择实际本地副本，未进行全库语义审计、真实模型推理或已安装程序的交互验证。未登记的知识、未知渠道、混合 OOC 原文、缺失/过期 fingerprint 和未来版本会保守返回 unknown；不会以生成式摘要填补缺口。

### 本次本地验证记录

2026-11-16：全量回归 7007 项通过、17 项跳过、零失败；收尾修改后的 121 项相关测试全部通过。主进程、预加载、渲染端类型检查、完整构建、字体资源与插件 schema 校验通过。后续仅变更本说明文档，不改变运行时代码。

全量结果及最终相关测试报告分别位于工作区忽略目录 `.build-temp/bridge-full-final.json` 和 `.build-temp/bridge-final-verified.json`，最终构建日志为 `.build-temp/bridge-final-build-verified.log`。这些报告不包含私人 CRP 数据。没有启动生产程序、调用真实模型或执行数据迁移，也没有提交或推送分支。
