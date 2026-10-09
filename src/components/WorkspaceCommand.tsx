"use client";

import { useEffect, useRef, useState } from "react";
import { Command, CommandCollection, CommandEmpty, CommandList, CommandItem, CommandFooter, CommandGroup, CommandGroupLabel } from "@/components/ui/command";
import { AutocompleteInput, AutocompletePopup } from "@/components/ui/autocomplete";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

export interface WorkspaceCommandEntry { value: string; label: string; group: string }

export function WorkspaceCommand({ items, onNavigate }: { items: WorkspaceCommandEntry[]; onNavigate: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const mobile = () => window.matchMedia("(max-width: 700px)").matches;
  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setExpanded(false);
    if (restoreFocus && mobile()) requestAnimationFrame(() => trigger.current?.focus());
  };
  useEffect(() => {
    if (expanded) input.current?.focus();
  }, [expanded]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !event.isComposing) {
        event.preventDefault();
        if (mobile()) setExpanded(true);
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || root.current?.contains(event.target) || event.target.closest(".workspace-search-results")) return;
      setOpen(false);
      setQuery("");
      setExpanded(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const navigate = (value: string) => { close(true); onNavigate(value); };
  const groups = [...new Set(items.map((item) => item.group))].map((group) => ({ group, items: items.filter((item) => item.group === group) }));
  const searching = query.trim().length > 0;
  return <div ref={root} className="workspace-search" data-expanded={expanded}>
    <Button ref={trigger} variant="ghost" size="icon" className="workspace-search-trigger" aria-label="메뉴·기능 검색" onClick={() => setExpanded(true)}>
      <Search aria-hidden="true" />
    </Button>
    <div className="workspace-search-field">
      <Command inline={false} open={open && searching} items={groups} value={query}
        onValueChange={(value, details) => {
          // This picker runs an action; do not fill its input with the selected menu label.
          if (details.reason === "item-press") { details.cancel(); return; }
          setQuery(value);
          setOpen(value.trim().length > 0);
        }}
        onOpenChange={(next, details) => {
          setOpen(next);
          if (!next && ["outside-press", "focus-out", "escape-key"].includes(details.reason)) close(details.reason === "escape-key");
        }}
        itemToStringValue={(item) => { const entry = item as WorkspaceCommandEntry; return `${entry.label} ${entry.group}`; }}>
        <AutocompleteInput ref={input} className="workspace-search-input" aria-label="메뉴·기능 검색" placeholder="메뉴·기능 검색…" startAddon={<Search />} showClear={searching}
          clearProps={{ "aria-label": "검색어 지우기" }}
          onFocus={() => { if (searching) setOpen(true); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === "Enter" || event.key === "Escape") event.preventBaseUIHandler();
              return;
            }
            if (event.key === "Escape") { event.preventBaseUIHandler(); event.preventDefault(); close(true); }
          }} />
        {!searching && <Kbd className="workspace-search-shortcut" aria-hidden="true">Ctrl K</Kbd>}
        <AutocompletePopup className="workspace-search-results">
          <CommandEmpty>일치하는 기능이 없습니다.</CommandEmpty>
          <CommandList>{(group: { group: string; items: WorkspaceCommandEntry[] }) => <CommandGroup key={group.group} items={group.items}>
            <CommandGroupLabel>{group.group}</CommandGroupLabel>
            <CommandCollection>{(item: WorkspaceCommandEntry) => <CommandItem key={item.value} value={item} onClick={() => navigate(item.value)}>
              {item.label}
            </CommandItem>}</CommandCollection>
          </CommandGroup>}</CommandList>
          <CommandFooter>↑ ↓ 선택 · Enter 이동 · Esc 닫기</CommandFooter>
        </AutocompletePopup>
      </Command>
      <Button variant="ghost" size="icon" className="workspace-search-close" aria-label="검색 닫기" onClick={() => close(true)}><X aria-hidden="true" /></Button>
    </div>
  </div>;
}
