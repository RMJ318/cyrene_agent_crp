# 已实现能力与操作边界

执行前读取实际部署包 manifest 与 context 能力清单。源码实现、可部署包、生产启用和真实 ChatGPT 验收是四个不同状态。

**当前旧库继续运行：** 2.0／2.1 的正式归档和审计使用固定 commit 下的旧 Skill、`archive/rp/automation/crp.py` 和 `audit_knowledge.py`；这些版本不以新 context 接口作为前置条件。未正式切换权威时不得用下述 canonical 接口写正式数据，也不把缺少新对象判作旧库错误。

## 仓库核心

Cyrene 施工仓库提供以下真实构建入口；目标 CRP 仓库没有安装它们时，不假设命令存在：

- `scripts/crp/build-repository-runtime.mjs`：生成可移植的 Node 24 核心包、三份 JSON Schema 和文件哈希 manifest。
- `scripts/crp/prepare-migration.mjs --snapshot <明确快照> --output <独立新文件>`：逐对象与逐审计条目复审队列，不做语义推断或正式迁移。

可移植核心 API 包括 CrpCoreStore、CrpCoreQueryAdapter、validateMigrationMap、auditCoverage、模型运行时和持久预算账本。打开源码或查询服务不会自动迁移权威。生产切换前，旧 crp.py 仍是现有入口；禁止将旧 CLI 和新核心同时用于正式写入。

CrpCoreStore 的初始化、发布目的地必须与原文源目录分离。发布需要固定基线、完整保护清单、追加 revision 和宿主认可的审核。审核回调、签名、资料外发同意由受信任宿主提供；不得在生产中为了绕过门禁临时写 `() => true`，也不能把模型填写 reviewed／accepted 当成审核。

迁移队列逐项引用原始路径、SHA256、JSON Pointer。未映射、未复核项保留 pending；结构映射完成不等于语义复核完成，语义复核完成也不等于全库审计完成。旧审计只映射 legacy-reference，原指纹与原始字节不重签发。

文稿可绑定有序来源片段、范围、明确 joiner 和整体 SHA256。joiner 未知则不能拼成 verbatim；不添加标题、换行或解释。来源校验和分页按 Unicode codepoint，不按 UTF-16 半个代理对截断。

## 全量审计闭合

auditCoverage 固定计划指纹、对象版本、源 SHA256、语义阅读范围和八项检查。补读重叠只计一次；同批次重试幂等，改内容须独立修订，不能复用同 ID。未读／未核对不写成 PASS 或已调查缺证。

批次只有经过宿主接受才计入完成；dispatch 状态和 `semantic: true` 文本本身没有授权力。跨批依赖须有对应取证才能解析，重开的依赖使用新身份。检查闭合、反向来源覆盖闭合、依赖清空后才可报告该明确范围 auditComplete；allFindingsPass 单独报告，发现冲突不意味着审计尚未进行。

中断保留已接受的不可变批次；恢复固定同一计划指纹，源变化先重新评估影响，不混用不同版本。实际阅读范围、未知剩余、候选修订、检查结论分别报告。

## ChatGPT 查询入口

现有 Code Life Project 按旧协议直接读取固定 commit 的 GitHub 原库；可选服务不作为普通 RP 的必要依赖，不因插件或认证失败强制迁移入口。

已配置 Actions 时先 openCrpContext，再 searchCrpMemory／readCrpMemory；当前旧快照兼容服务另有 crpTimeline、relatedCrpMemories、explainCrpRecall。canonical 核心有八方法，但以实际 context 清单为准，不调用未公布的未来接口。

作者和角色使用不同的服务凭据；模型参数不能指定更大现实、另一人物或更晚时点。收到 403 停止，旧 context 重新打开后至多补查一次；不能转用作者凭据、GitHub 全仓访问或上传作者包绕过角色隔离。

没有真实服务工具时，继续使用固定 commit GitHub 阅读。必须从实际原转录满足旧协议要求的 N 轮双方原文，不以摘要或静态记忆包替代。ChatGPT 现有普通对话不会因 Skill 出现自动得到 Actions 或 MCP。

部署和模拟测试不算真实两端验收。最终必须由目标 ChatGPT 发起认证调用，核验作者来源、角色时点与取得边界、撤销、更新后的召回及实际回答；没有调用记录时保留 UNVERIFIED。模型 API、发布、域名和公开服务继续沿用用户实际授权。
