# CRP 自动同步

GitHub 主分支是 RP 原文的上游。独立服务器使用专用**只读**部署密钥拉取仓库，不执行仓库中的脚本、钩子、过滤器或子模块；校验通过才发布新快照。Webhook 通知即时刷新，定时拉取作为补偿。Cyrene 通过 HTTPS 和绑定设备的独立令牌获取更新，验证全部字节后原子切换；离线仍使用最后一个完整本地快照。

Cyrene 的原生记忆、Wiki、摘要及 Bridge 本地记录同步到服务器的独立版本库，默认每五分钟创建或更新私有仓库的设备 PR。首次上传立即尝试创建 PR。发布使用本机既有 Git／GitHub CLI 凭证；服务器不持有能写 GitHub 的广泛令牌。PR 只修改 `archive/cyrene-memory/<device>/`，不会写 main、合并 PR、修改 RP 原文或删除 2.x。主分支更新时 PR 的父提交与树会跟进，保留分支历史，避免覆盖上游变化。

个人记忆保留 Writer／明确的 #0 范围，不自动授予 RP 人物知识。Bridge 中敏感记录保留本机密文，临时逐轮同意表不外传。嵌入缓存、模型文件、聊天原文、模型设置和密钥不在同步清单中；向量索引可由原有文本重建。检测到凭据材料时会阻止该次传送和发布。服务器写入带版本条件，重发幂等，旧版本保留；文件移除通过最新清单及 Git 历史表达。

## 构建与验证

```sh
node scripts/crp/build-sync-service.mjs
node node_modules/vitest/vitest.mjs run src/main/crp-sync src/main/memory-bridge
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.main.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.renderer.json
```

构建产物只含运行时，位于 `.build-temp/crp-sync-runtime/`。部署时从该目录构建 Docker 镜像。服务根文件系统只读、移除能力、禁止提权；仅独立数据目录可写。专用 SSH 私钥、GitHub 主机校验公钥、Webhook 密钥、设备令牌摘要与旧查询认证配置从独立只读目录挂载，均不进入镜像或 Git。公开反向代理只新增 `/sync/v1/`；旧 `/v1/` 查询可交给新服务的兼容网关，旧服务可保留作回退。

服务器 `CRP_SYNC_CONFIG` 指向私有 JSON 配置：

```json
{
  "root": "/var/lib/crp-sync",
  "repository": "OWNER/ARCHIVE",
  "channels": { "main": "main" },
  "pollMs": 15000,
  "sshKey": "/run/crp-sync/deploy-key",
  "knownHosts": "/run/crp-sync/known-hosts",
  "webhookSecretFile": "/run/crp-sync/webhook.secret",
  "queryAuthFile": "/run/query/auth.json",
  "cursorKeyFile": "/run/query/cursor.key",
  "devices": [{ "deviceId": "11111111-1111-4111-8111-111111111111", "tokenSha256": "<SHA256 of the device token>", "channels": ["main"] }]
}
```

Webhook 指向 `/sync/v1/github-hook`，只订阅 push，启用 SSL 验证，并配置独立密钥。该入口验证原始请求的 HMAC，不使用设备令牌。恢复时会验证持久化的活动快照，失败不会发布部分数据。主分支或审计校验失败时保留上一个有效版本并报告错误。

若保留原 MCP 备用入口，可以设置 `CRP_SYNC_DATA_DIR=/data/crp-sync`，把同步服务的 `data/published` 和 `data/snapshots` 分别只读挂载为 `/data/crp-sync` 和 `/data/crp-sync/snapshots`（预先创建嵌套挂载点）。这样它会跟随同一主分支快照，OAuth 与角色范围仍由原主机配置约束。不要把个人记忆 inbox 或 Git 凭据挂载给 MCP 容器。

客户端将 `client.example.json` 的私有实例放在 Electron 用户数据目录的 `crp-sync.json`，令牌放在同目录之外的指定受限文件或该用户私有目录中；绝不放进源码仓库。现有 Git 和 `gh` 必须具有私有库读取、设备分支推送和创建 PR 的权限。正常重启 Cyrene 后自动启动同步，设置页显示服务器版本、上传版本、PR 保存版本和重试状态。没有此配置时保持原来的本地工作方式；不启动同步连接或初始化个人数据库。

本模块不调用模型。本地模型关闭时同步仍正常工作。新增的隔离验收通道可以验证传输和更新，不需要向生产 main 写测试数据；未合并的 3.0 候选也可配置独立只读通道，保留原生产入口。
