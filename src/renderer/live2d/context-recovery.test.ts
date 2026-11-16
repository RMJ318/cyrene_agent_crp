import { afterEach, describe, expect, it, vi } from "vitest";
import { Live2DContextRecovery } from "./context-recovery";

afterEach(() => { vi.useRealTimers(); });
function fixture(saved = new Map<string, string>()) {
  const canvas = new EventTarget();
  const options = { pause: vi.fn(), reload: vi.fn(), report: vi.fn(),
    storage: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } },
    now: () => 100_000 };
  const recovery = new Live2DContextRecovery(canvas, options);
  return { canvas, options, recovery, saved };
}
describe("Live2D GPU 上下文恢复", () => {
  it("丢失上下文后暂停，恢复时只重载一次", () => {
    const f = fixture();
    const loss = new Event("webglcontextlost", { cancelable: true });
    f.canvas.dispatchEvent(loss);
    expect(loss.defaultPrevented).toBe(true);
    expect(f.options.pause).toHaveBeenCalledOnce();
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(f.options.reload).toHaveBeenCalledOnce();
    f.recovery.dispose();
  });
  it("驱动不发送恢复事件时也能触发恢复", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.canvas.dispatchEvent(new Event("webglcontextlost"));
    vi.advanceTimersByTime(5000);
    expect(f.options.reload).toHaveBeenCalledOnce();
    f.recovery.dispose();
  });
  it("跨重载保留限制，避免坏驱动造成无限循环", () => {
    const saved = new Map<string, string>();
    for (let i = 0; i < 3; i++) {
      const f = fixture(saved);
      f.canvas.dispatchEvent(new Event("webglcontextlost"));
      f.canvas.dispatchEvent(new Event("webglcontextrestored"));
      expect(f.options.reload).toHaveBeenCalledTimes(i < 2 ? 1 : 0);
      if (i === 2) expect(f.options.report).toHaveBeenCalledWith("recovery_blocked");
      f.recovery.dispose();
    }
  });
  it("释放后移除事件和恢复定时器", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.canvas.dispatchEvent(new Event("webglcontextlost"));
    f.recovery.dispose();
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    vi.advanceTimersByTime(6000);
    expect(f.options.reload).not.toHaveBeenCalled();
  });
  it("未曾丢失上下文时不重载，存储不可用时不冒险进入循环", () => {
    const f = fixture();
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(f.options.reload).not.toHaveBeenCalled();
    f.options.storage.setItem = () => { throw new Error("denied"); };
    f.canvas.dispatchEvent(new Event("webglcontextlost"));
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(f.options.report).toHaveBeenCalledWith("recovery_blocked");
    expect(f.options.reload).not.toHaveBeenCalled();
    f.recovery.dispose();
  });
});
