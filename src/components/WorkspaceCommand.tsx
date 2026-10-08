"use client";

import { useEffect, useState } from "react";
import { Command, CommandCollection, CommandDialog, CommandDialogTrigger, CommandDialogPopup, CommandInput, CommandEmpty, CommandList, CommandItem, CommandPanel, CommandFooter, CommandGroup, CommandGroupLabel } from "@/components/ui/command";
import { DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

export interface WorkspaceCommandEntry { value: string; label: string; group: string }

export function WorkspaceCommand({ items, onNavigate }: { items: WorkspaceCommandEntry[]; onNavigate: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
        setQuery("");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const navigate = (value: string) => { setOpen(false); setQuery(""); onNavigate(value); };
  const groups = [...new Set(items.map((item) => item.group))].map((group) => ({ group, items: items.filter((item) => item.group === group) }));
  const searching = query.trim().length > 0;
  return <CommandDialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
    <CommandDialogTrigger aria-label="메뉴·기능 검색" render={<Button variant="outline" className="workspace-search-trigger" />}>
      <Search aria-hidden="true" />
      <span className="workspace-search-label">메뉴·기능 검색</span>
      <Kbd className="workspace-search-shortcut" aria-hidden="true">Ctrl K</Kbd>
    </CommandDialogTrigger>
    <CommandDialogPopup>
      <DialogTitle className="sr-only">작업 공간 기능 검색</DialogTitle>
      <DialogDescription className="sr-only">기존 기능을 검색하고 Enter로 이동합니다. 문서 내용은 검색하거나 저장하지 않습니다.</DialogDescription>
      <Command items={groups} value={query} onValueChange={setQuery} itemToStringValue={(item) => { const entry = item as WorkspaceCommandEntry; return `${entry.label} ${entry.group}`; }}>
        <CommandInput aria-label="기능 검색" placeholder="기능 검색…" />
        {/* Empty query shows the input only: the sidebar already lists every destination. */}
        {searching ? <>
          <CommandPanel className="command-results rounded-none border-x-0 border-t border-b-0 bg-transparent shadow-none before:hidden [clip-path:none]">
            <CommandEmpty className="px-5 text-left text-muted-foreground text-sm not-empty:py-3">일치하는 기능이 없습니다.</CommandEmpty>
            <CommandList>{(group: { group: string; items: WorkspaceCommandEntry[] }) => <CommandGroup key={group.group} items={group.items}>
              <CommandGroupLabel>{group.group}</CommandGroupLabel>
              <CommandCollection>{(item: WorkspaceCommandEntry) => <CommandItem key={item.value} value={item} onClick={() => navigate(item.value)}>
                <strong>{item.label}</strong>
              </CommandItem>}</CommandCollection>
            </CommandGroup>}</CommandList>
          </CommandPanel>
          <CommandFooter className="[.command-results:has([data-slot=command-empty]:not(:empty))+&]:hidden">↑ ↓ 선택 · Enter 이동 · Esc 닫기</CommandFooter>
        </> : null}
      </Command>
    </CommandDialogPopup>
  </CommandDialog>;
}
