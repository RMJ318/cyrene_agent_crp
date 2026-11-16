import { Checkbox, Popover } from "antd";
import { useEffect, useRef, useState } from "react";
import type { RealityRecallState } from "../../../../../shared/memory-bridge";
import "./RealityMemorySelector.css";

export function RealityMemorySelector({ sessionId, busy = false }: { sessionId?: string; busy?: boolean }) {
  const [state, setState] = useState<RealityRecallState>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const request = async (command: string, realities?: string[]) => {
    const api = window.memoryBridge;
    if (!api) throw new Error("当前版本未提供现实记忆接口");
    const response = await api.request(command, { sessionId, ...(realities ? { realities } : {}) }) as { ok: boolean; value: RealityRecallState; error?: string };
    if (!response.ok) throw new Error(response.error ?? "读取现实记忆失败");
    return response.value;
  };
  const load = async (token: number) => {
    try { const next = await request("recall-state"); if (generation.current === token) { setState(next); setError(""); } }
    catch { if (generation.current === token) setError("暂时无法读取现实记忆，请稍后重试"); }
  };
  useEffect(() => {
    const token = ++generation.current; setState(undefined); setSaving(false); setError(""); setOpen(false);
    void load(token);
    return () => { generation.current++; };
  }, [sessionId]);
  const change = async (realities: string[]) => {
    const token = ++generation.current; setSaving(true); setError("");
    try { const next = await request("set-recall", realities); if (generation.current === token) setState(next); }
    catch { if (generation.current === token) setError("保存失败，已保留原来的勾选项"); }
    finally { if (generation.current === token) setSaving(false); }
  };
  const count = state?.realities.length ?? 0;
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next && !saving) void load(++generation.current); }} trigger="click" placement="topLeft"
    arrow={false} rootClassName="cy-composer-menu-popover" content={<div className="cy-reality-memory-menu">
      <strong>召回现实记忆</strong>
      <small>可多选。资料按现实区分，仅作查档参考。</small>
      {state?.dedicated ? <p>此会话已有专用记忆范围，请在记忆设置中管理。</p> : <>
        {!state?.enabled && <p>请先在记忆设置中开启 Bridge 并导入 CRP 快照。</p>}
        <div className="cy-reality-memory-menu__options">
          {(state?.available ?? []).map(id => <Checkbox key={id} checked={state!.realities.includes(id)} disabled={busy || saving || !state?.enabled}
            onChange={event => void change(event.target.checked ? [...state!.realities, id] : state!.realities.filter(selected => selected !== id))}>
            现实 #{id}{id === "0" ? " · 作者层" : ""}
          </Checkbox>)}
        </div>
        {state?.enabled && !state.available.length && <p>当前快照尚无可召回的现实记忆。</p>}
        <button type="button" className="cy-reality-memory-menu__clear" disabled={busy || saving || !count} onClick={() => void change([])}>全部关闭</button>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>}>
    <button type="button" className="cy-composer__agent-button cy-model-selector cy-reality-memory-selector" aria-label="选择召回的现实记忆" aria-expanded={open}
      title={count ? `召回现实：${state!.realities.map(id => `#${id}`).join("、")}` : "选择需要召回的 CRP 现实记忆"}>
      <span>现实记忆{count ? ` · ${count}` : ""}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
    </button>
  </Popover>;
}
