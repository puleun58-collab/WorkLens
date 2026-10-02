"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandCollection, CommandDialog, CommandDialogPopup, CommandDialogTrigger, CommandInput, CommandEmpty, CommandList, CommandItem, CommandPanel, CommandFooter, CommandGroup, CommandGroupLabel } from "@/components/ui/command";
import { DialogTitle, DialogDescription } from "@/components/ui/dialog";

export interface WorkspaceCommandEntry { value: string; label: string; group: string }

export function WorkspaceCommand({ items, onNavigate }: { items: WorkspaceCommandEntry[]; onNavigate: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const navigate = (value: string) => { setOpen(false); onNavigate(value); };
  const groups = [...new Set(items.map((item) => item.group))].map((group) => ({ group, items: items.filter((item) => item.group === group) }));
  return <CommandDialog open={open} onOpenChange={setOpen}>
    <CommandDialogTrigger render={<Button variant="outline" className="workspace-command-trigger" />}>
      <Search aria-hidden="true" /><span>기능 검색…</span>
    </CommandDialogTrigger>
    <CommandDialogPopup>
      <DialogTitle className="sr-only">작업 공간 기능 검색</DialogTitle>
      <DialogDescription className="sr-only">기존 기능을 검색하고 Enter로 이동합니다. 문서 내용은 검색하거나 저장하지 않습니다.</DialogDescription>
      <Command items={groups} itemToStringValue={(item) => { const entry = item as WorkspaceCommandEntry; return `${entry.label} ${entry.group}`; }}>
        <CommandInput aria-label="기능 검색" placeholder="기능 검색…" />
        <CommandPanel>
          <CommandEmpty>일치하는 기능이 없습니다.</CommandEmpty>
          <CommandList>{(group: { group: string; items: WorkspaceCommandEntry[] }) => <CommandGroup key={group.group} items={group.items}>
            <CommandGroupLabel>{group.group}</CommandGroupLabel>
            <CommandCollection>{(item: WorkspaceCommandEntry) => <CommandItem key={item.value} value={item} onClick={() => navigate(item.value)}>
              <strong>{item.label}</strong>
            </CommandItem>}</CommandCollection>
          </CommandGroup>}</CommandList>
        </CommandPanel>
        <CommandFooter>↑ ↓ 선택 · Enter 이동 · Esc 닫기</CommandFooter>
      </Command>
    </CommandDialogPopup>
  </CommandDialog>;
}
