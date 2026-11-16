import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Input, Modal, Select, Space } from "antd";
import type { BridgeDomain, BridgeScope, BridgeStatus, LocalMemoryRecord } from "../../../../shared/memory-bridge";

/** All writes are explicit user actions. No mount effect reads or initializes personal databases. */
export function MemoryBridgePanel() {
  const [modal, modalContext] = Modal.useModal();
  const confirmAction = (message: string): Promise<boolean> => new Promise(resolve => {
    modal.confirm({ title: "确认记忆操作", content: message, okText: "确认", cancelText: "取消", onOk: () => { resolve(true); }, onCancel: () => { resolve(false); } });
  });
  const [status, setStatus] = useState<BridgeStatus>();
  const [repository, setRepository] = useState("");
  const [domain, setDomain] = useState<BridgeDomain>("rp");
  const [audience, setAudience] = useState<BridgeScope["audience"]>("archive-reference");
  const [reality, setReality] = useState("33550336");
  const [branch, setBranch] = useState("");
  const [character, setCharacter] = useState("cyrene");
  const [day, setDay] = useState("9");
  const [clock, setClock] = useState("");
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [sensitive, setSensitive] = useState(true);
  const [records, setRecords] = useState<LocalMemoryRecord[]>([]);
  const [editing, setEditing] = useState<LocalMemoryRecord>();
  const [session, setSession] = useState("");
  const [backupId, setBackupId] = useState("");
  const [stagedFile, setStagedFile] = useState("");
  const [preview, setPreview] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelTarget, setModelTarget] = useState("");
  const [modelTargetToken, setModelTargetToken] = useState("");
  const [continuityFiles, setContinuityFiles] = useState<string[]>([]);
  const [continuityPath, setContinuityPath] = useState("");
  const [continuitySummary, setContinuitySummary] = useState("");
  const [mappingId, setMappingId] = useState("");
  const call = async (command: string, input: Record<string, unknown> = {}) => {
    if (!window.memoryBridge) throw new Error("Bridge 接口不可用");
    const response = await window.memoryBridge.request(command, input) as { ok: boolean; value?: any; error?: string; cancelled?: boolean };
    if (!response.ok) throw new Error(response.error ?? "Bridge 操作失败");
    return response.value;
  };
  const refresh = async () => setStatus(await call("status"));
  useEffect(() => { let active = true; void call("status").then(value => { if (active) setStatus(value); }).catch(() => {}); return () => { active = false; }; }, []);
  useEffect(() => {
    let active = true; setModelTarget(""); setModelTargetToken("");
    if (session) void call("model-target", { sessionId: session }).then(value => { if (active) { setModelTarget(value.display); setModelTargetToken(value.token); } }).catch(() => {});
    return () => { active = false; };
  }, [session]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setNotice("");
    try { await work(); await refresh(); }
    catch (error) {
      const messages: Record<string, string> = {
        BRIDGE_GIT_NOT_INSTALLED: "未找到 Git，请先安装 Git for Windows。",
        BRIDGE_GITHUB_FETCH_FAILED: "GitHub 拉取失败：请检查网络、仓库名称，以及本机 Git 是否已登录并有读取权限。",
        BRIDGE_INVALID_GITHUB_REPOSITORY: "请输入 owner/repository 或 https://github.com/owner/repository。",
        BRIDGE_GITHUB_CANCELLED: "已取消 GitHub 导入，当前快照保持不变。",
        BRIDGE_LOCAL_MODELS_DISABLED: "当前环境已禁止 CRP 本地模型，保留关键词检索。",
      };
      setNotice(error instanceof Error ? messages[error.message] ?? error.message : "Bridge 操作失败");
    }
    finally { setBusy(false); }
  };
  const scope = (): BridgeScope => ({ domain, realityId: domain === "writer" ? "-1" : domain === "reality0" ? "0" : reality,
    branchId: branch.trim() || null, audience: domain === "rp" ? audience : "archive-reference",
    ...(domain === "rp" && audience === "character-knowledge" ? { characterId: character } : {}),
    ...(domain === "rp" && day.trim() ? { asOf: { day: Number(day), ...(clock ? { clock } : {}) } } : {}),
  });
  const list = async () => setRecords(await call("list", { domain }));
  const retrievalV3Available = typeof status?.retrievalV3Enabled === "boolean";
  if (typeof window === "undefined" || !window.memoryBridge) return null;
  return <section className="cy-settings-section" aria-label="CRP Memory Bridge">
    {modalContext}
    <div className="cy-settings-section__heading"><h2>CRP Memory Bridge v0.1</h2><p>共享知识，独立经历。三域隔离、本地检索、只读 CRP；普通会话可在模型名右侧多选现实，也可创建专用隔离会话。</p></div>
    <Alert type="info" showIcon title="默认关闭，不调用检索模型，不自动保存对话。" description="先在插件页启用 CRP Memory Bridge，再开启下方开关。查询资料可能随日常对话发送给当前模型；个人记录需逐轮授权。切换现实、人物或故事时点请创建新会话。" />
    {notice && <Alert type="error" showIcon title={notice} />}
    <Space wrap style={{ margin: "12px 0" }}>
      <Button disabled={busy} onClick={() => void action(async () => { await call("enable", { enabled: !status?.configuredEnabled }); })}>{status?.configuredEnabled ? "停用 Bridge" : "开启 Bridge"}</Button>
      <Button disabled={busy} onClick={() => void action(async () => { await call("import"); })}>选择 CRP 本地副本并导入快照</Button>
      <Button onClick={() => void call("cancel").catch(() => {})}>取消当前导入／查询</Button>
      <Button disabled={busy} onClick={() => void action(async () => { await call("rollback"); })}>回滚上一快照</Button>
    </Space>
    <Space wrap>
      <Input aria-label="GitHub CRP 仓库" placeholder={status?.githubSource?.repository ?? "owner/repository"} value={repository} onChange={e => setRepository(e.target.value)} style={{ width: 320 }} />
      <Button disabled={busy || !(repository.trim() || status?.githubSource?.repository)} onClick={() => void action(async () => { await call("import-github", { repository: repository.trim() || status?.githubSource?.repository }); })}>从 GitHub 导入／更新</Button>
    </Space>
    <p>只读获取默认分支的最新 commit，使用本机 Git 凭证；私有仓库需先在本机配置 Git 读取权限，不在此输入令牌。</p>
    {status?.githubSource && <p>GitHub 来源：{status.githubSource.repository} · commit：{status.githubSource.commit}</p>}
    <p>当前快照：{status?.snapshotId ?? "未配置"} · 检索付费预算：USD 0</p>
    {status?.sync && <div aria-label="CRP 自动同步">
      <p>服务器同步：{status.sync.lastError ? `等待重试（${status.sync.lastError}）` : status.sync.commit ? `最近已同步 ${status.sync.commit.slice(0, 12)}` : "正在连接"}
        {status.sync.uploadedRevision !== undefined && ` · 记忆已上传第 ${status.sync.uploadedRevision} 版`}
        {status.sync.publishedRevision !== undefined && ` · GitHub PR 已保存第 ${status.sync.publishedRevision} 版`}</p>
      <Button disabled={busy} onClick={() => void action(async () => { await call("sync-now"); })}>立即同步并刷新状态</Button>
    </div>}
    <Checkbox checked={status?.retrievalV3Enabled === true} disabled={busy || !retrievalV3Available} onChange={e => void action(async () => { await call("retrieval-v3", { enabled: e.target.checked }); })}>试用 CRP 3.0 检索：授权原文片段、文稿正文与多路融合（可关闭回退）</Checkbox>
    {status && !retrievalV3Available && <p>当前主进程尚未提供 CRP 3.0 检索；请正常重启 Cyrene 后再启用。已加载快照与原检索保持可用。</p>}
    <Checkbox checked={status?.localSemanticEnabled === true && !status?.localModelsDisabled} disabled={busy || status?.localModelsDisabled} onChange={e => void action(async () => { await call("local-semantic", { enabled: e.target.checked }); })}>启用已安装的本地 BGE-M3 语义检索（不下载、不联网；默认仅 BM25）</Checkbox>
    {status?.localModelsDisabled && <p>当前环境已禁止 CRP 本地模型；不探测或加载模型，保留关键词检索。</p>}
    <Space wrap>
      <Select aria-label="记忆域" value={domain} onChange={value => { setDomain(value); setRecords([]); setEditing(undefined); setContent(""); setPreview(""); }} options={[{ value: "rp", label: "RP 档案" }, { value: "writer", label: "Writer 现实 #-1" }, { value: "reality0", label: "作者层 #0" }]} />
      {domain === "rp" && <>
        <Input aria-label="现实编号" placeholder="现实编号" value={reality} onChange={e => setReality(e.target.value)} style={{ width: 130 }} />
        <Select aria-label="查询视图" value={audience} onChange={setAudience} options={[{ value: "archive-reference", label: "作者查档参考" }, { value: "character-knowledge", label: "人物有效知识" }]} />
        <Input aria-label="分支编号" placeholder="分支 ID；未登记则留空" value={branch} onChange={e => setBranch(e.target.value)} style={{ width: 190 }} />
        {audience === "character-knowledge" && <Input aria-label="人物 ID" value={character} onChange={e => setCharacter(e.target.value)} style={{ width: 120 }} />}
        <Input aria-label="故事日" placeholder="故事日" value={day} onChange={e => setDay(e.target.value)} style={{ width: 80 }} />
        <Input aria-label="故事时刻" placeholder="HH:MM；空为日末" value={clock} onChange={e => setClock(e.target.value)} style={{ width: 165 }} />
      </>}
      <Button disabled={busy || !status?.enabled} onClick={() => void action(async () => { if (await confirmAction("此专用会话仅使用当前范围；CRP 查询结果可能发送到会话当前配置的模型服务。是否继续？")) await call("new-session", { scope: scope(), confirmed: true }); })}>创建并打开隔离会话</Button>
    </Space>
    <Space wrap style={{ margin: "12px 0" }}>
      <Input aria-label="本地预览关键词" placeholder="本地检索预览，不发送模型" value={query} onChange={e => setQuery(e.target.value)} style={{ width: 260 }} />
      <Button disabled={busy} onClick={() => void action(async () => { setPreview(JSON.stringify(await call("preview", { scope: scope(), query }), null, 2)); })}>本地预览</Button>
    </Space>
    {domain === "rp" && <details><summary>原文待归档的连续性记录：显式审核映射</summary>
      <p>只有你核对来源后才保存映射。它始终标注为连续性摘要、RP 原文待归档；人物视图还需确认该人物已在上方时点取得该知识。快照更新后映射需重新审核。</p>
      <Button disabled={busy} onClick={() => void action(async () => { setContinuityFiles(await call("continuity-files")); })}>列出快照中的连续性文件</Button>
      <Select aria-label="连续性来源" placeholder="选择已核对的连续性文件" value={continuityPath || undefined} onChange={setContinuityPath} style={{ width: "100%" }} options={continuityFiles.map(value => ({ value, label: value }))} />
      <Input.TextArea aria-label="连续性有界摘要" value={continuitySummary} onChange={e => setContinuitySummary(e.target.value)} maxLength={1200} placeholder="你已核对的摘要，不填充未经确认的原文或剧情" />
      <Button disabled={busy || !continuityPath || !continuitySummary.trim() || !day} onClick={() => void action(async () => {
        if (await confirmAction("确认来源、现实、分支、发生/取得时点和人物权限均已核对？这不是原文审计 PASS。")) {
          await call("map-continuity", { scope: scope(), path: continuityPath, content: continuitySummary, confirmed: true }); setContinuitySummary("");
        }
      })}>确认该范围的连续性映射</Button>
      <Input aria-label="待撤销映射 ID" value={mappingId} onChange={e => setMappingId(e.target.value)} placeholder="需要纠正时，粘贴本地预览返回的 continuity:... ID" />
      <Button disabled={busy || !mappingId} onClick={() => void action(async () => {
        if (await confirmAction("撤销此本地连续性映射？CRP 来源保持原样。之后可以重新审核保存。")) { await call("unmap-continuity", { id: mappingId, confirmed: true }); setMappingId(""); setPreview(""); }
      })}>撤销映射</Button>
    </details>}
    {(status?.sessions ?? []).map(row => <p key={row.id}>
      {row.scope.domain} #{row.scope.realityId} · {row.scope.characterId ?? row.scope.audience} · {row.scope.asOf ? `第${row.scope.asOf.day}日 ${row.scope.asOf.clock ?? "日末"}` : "无故事时点"} · {row.id.slice(0, 8)} {row.active ? "" : "（已停用，仍禁止回填）"} {" "}
      <Button size="small" disabled={busy || !row.active} onClick={() => void action(async () => { await call("open-session", { sessionId: row.id }); })}>打开</Button>{" "}
      <Button size="small" disabled={busy || !row.active} onClick={() => void action(async () => { await call("deactivate", { sessionId: row.id }); })}>停用会话</Button>
    </p>)}
    {domain !== "rp" && <>
      <h3>显式管理 {domain === "writer" ? "Writer" : "作者层"} 记忆</h3>
      <Space wrap><Button disabled={busy} onClick={() => void action(list)}>读取本地记录</Button>
        <Button disabled={busy} onClick={() => void action(async () => { setBackupId(String(await call("backup", { domain, confirmed: true }))); })}>建立备份</Button>
        <Button disabled={busy} onClick={() => void action(async () => { if (await confirmAction("导出会在本页显示全部记录，包括敏感信息和历史删除标记。确认？")) setPreview(JSON.stringify(await call("export", { domain, confirmed: true, allowSensitive: true }), null, 2)); })}>本地导出预览</Button>
      </Space>
      <Input.TextArea aria-label="待保存记忆" placeholder="只保存你确认的事实；不会从 RP 自动填充" value={content} onChange={e => setContent(e.target.value)} autoSize={{ minRows: 3, maxRows: 9 }} maxLength={12000} />
      <Space wrap><Checkbox checked={sensitive} onChange={e => setSensitive(e.target.checked)}>敏感内容（加密保存）</Checkbox>
        <Button disabled={busy || !content.trim()} onClick={() => void action(async () => {
          await call(editing ? "update" : "create", { domain, id: editing?.id, revision: editing?.revision, record: { content, sensitive, participants: [] }, confirmed: true });
          setContent(""); setEditing(undefined); await list();
        })}>{editing ? "确认更新该记录" : "确认保存新记录"}</Button>
        {editing && <Button onClick={() => { setEditing(undefined); setContent(""); }}>取消编辑</Button>}
      </Space>
      <p>敏感记录仅在系统加密可用时保存。可恢复删除保留历史；永久删除不自动清理旧备份。</p>
      <Select aria-label="本轮模型授权会话" placeholder="选择授权会话" value={session || undefined} onChange={setSession} style={{ width: "100%" }} options={(status?.sessions ?? []).filter(s => s.active && s.scope.domain === domain).map(s => ({ value: s.id, label: `${s.scope.domain} · ${s.id.slice(0, 8)}` }))} />
      {session && <p>接收方：{modelTarget || "读取会话模型信息中…"}。授权仅限下一轮运行，10 分钟内有效；更新、撤销和恢复后必须重新授权。</p>}
      {records.map(record => <div key={record.id} style={{ borderTop: "1px solid var(--ant-color-border)", padding: "12px 0" }}>
        <p>{record.sensitive ? "🔒 " : ""}v{record.revision} {record.deleted ? "（已删除）" : ""} {record.content}</p>
        <Space wrap>
          <Button size="small" disabled={busy} onClick={() => { setEditing(record); setContent(record.content); setSensitive(record.sensitive); }}>编辑／恢复为新版本</Button>
          <Button size="small" disabled={busy} onClick={() => void action(async () => { setPreview(JSON.stringify(await call("versions", { domain, id: record.id }), null, 2)); })}>历史版本</Button>
          <Button size="small" disabled={busy || !session || record.deleted || !modelTarget} onClick={() => void action(async () => {
            if (await confirmAction(`允许将这条记录用于下一轮对话并发送至 ${modelTarget}？`)) await call("grant", { domain, id: record.id, revision: record.revision, sessionId: session, expectedModelTarget: modelTargetToken, confirmed: true });
          })}>授权下一轮模型读取</Button>
          <Button size="small" disabled={busy} onClick={() => void action(async () => { await call("revoke", { domain, id: record.id, confirmed: true }); })}>撤销授权</Button>
          <Button size="small" disabled={busy} onClick={() => void action(async () => { await call("delete", { domain, id: record.id, revision: record.revision, confirmed: true }); await list(); })}>可恢复删除</Button>
          <Button size="small" danger disabled={busy} onClick={() => void action(async () => { if (await confirmAction("永久删除这条记录及其所有版本？旧备份需另行清理。")) { await call("delete", { domain, id: record.id, revision: record.revision, permanent: true, confirmed: true }); await list(); } })}>永久删除</Button>
        </Space>
      </div>)}
      <Space wrap style={{ margin: "12px 0" }}>
        <Input aria-label="备份 ID" placeholder="备份 ID" value={backupId} onChange={e => setBackupId(e.target.value)} style={{ width: 300 }} />
        <Button disabled={busy || !backupId} onClick={() => void action(async () => { const value = await call("restore", { domain, backupId, confirmed: true }); setStagedFile(value.stagedFile); setPreview(JSON.stringify(value.preview, null, 2)); })}>恢复到新库并预览</Button>
        <Button disabled={busy || !stagedFile} onClick={() => void action(async () => { if (await confirmAction("切换到预览的新库？旧库保留，所有模型授权失效。")) { await call("activate-restore", { domain, stagedFile, confirmed: true }); setStagedFile(""); await list(); } })}>确认使用预览的新库</Button>
      </Space>
    </>}
    {preview && <><Button onClick={() => setPreview("")}>清除本地预览</Button><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 400, overflow: "auto" }}>{preview}</pre></>}
  </section>;
}
