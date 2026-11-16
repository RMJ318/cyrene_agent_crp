import type { CrpAlias } from "./contracts";
import type { SearchToken } from "../rag/text-ranking";

/** Query-only normalization. Original source and user transcript are never rewritten. */
export function planCrpQuery(input: string, aliases: readonly CrpAlias[] = [], selectedRealities: readonly string[] = aliases.map(a => a.realityId)) {
  const selected = new Set(selectedRealities);
  const normalized = input.slice(0, 2000)
    .replace(/^\s*(?:测试一下记忆|测试记忆|记忆测试|帮我测试一下记忆)\s*[:：，,]?\s*/u, "")
    .replace(/^(?:你还记得|还记得|你记得|记不记得|请回忆一下|回忆一下)\s*/u, "")
    .replace(/#(\d+)/g, (match, id: string) => selected.has(id) ? " " : match)
    .replace(/(?:的时候|那时候|这件事)?(?:吗|么|呢)?[？?。!！\s]*$/u, "").trim();
  const entities = new Map<string, Set<string>>();
  let focus = normalized;
  for (const alias of [...aliases].sort((a, b) => b.text.length - a.text.length)) {
    if (alias.text.length < 2 || !normalized.includes(alias.text)) continue;
    const set = entities.get(alias.realityId) ?? new Set<string>();
    set.add(alias.entityId); entities.set(alias.realityId, set);
    focus = focus.split(alias.text).join(" ");
  }
  focus = focus.replace(/^[\s和与及、]+|[\s和与及、]+$/gu, "").replace(/\s+/g, " ").trim();
  return { normalized: normalized || input.slice(0, 2000), focus: focus || normalized, entities };
}

/** CJK bigrams bridge context-dependent jieba boundaries without a model or global dictionary changes. */
export function characterSearchTokens(text: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  for (const match of text.matchAll(/[\u3400-\u9fff]+|[a-zA-Z0-9_]+/gu)) {
    const part = match[0].toLowerCase(), chars = Array.from(part);
    const words = /[\u3400-\u9fff]/u.test(part) ? chars.length === 1 ? chars : chars.slice(0, -1).map((_, i) => chars.slice(i, i + 2).join("")) : [part];
    for (const word of words) tokens.push({ word, tag: "x", isStop: false, isNoun: false });
  }
  return tokens;
}
