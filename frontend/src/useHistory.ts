import { useRef, useState } from 'react';
import type { Config } from './types';

export default function useHistory() {
  const [value, render] = useState<Config | null>(null);
  const [,refresh] = useState(0);
  const current = useRef<Config | null>(null);
  const past = useRef<Config[]>([]), future = useRef<Config[]>([]);
  const transaction = useRef<Config | null>(null);
  const equal = (a: Config | null,b: Config | null) => JSON.stringify(a) === JSON.stringify(b);
  function push(before: Config) { past.current = [...past.current.slice(-99),before]; future.current=[]; }
  function set(next: Config | null | ((config: Config | null) => Config | null)) {
    const resolved = typeof next === 'function' ? next(current.current) : next;
    if (equal(resolved,current.current)) return;
    if (current.current && !transaction.current) push(current.current);
    current.current=resolved; render(resolved);
  }
  function begin() { if (!transaction.current) transaction.current=current.current; }
  function end() {
    const before=transaction.current;transaction.current=null;
    if (before && !equal(before,current.current)) {push(before);refresh(n=>n+1);}
  }
  function reset(next: Config) { past.current=[]; future.current=[]; transaction.current=null; current.current=next; render(next); }
  function sync(next: Config) { current.current=next; render(next); }
  function undo() { end(); const before=past.current.pop(); if (before && current.current) { future.current.push(current.current); current.current=before; render(before); } }
  function redo() { end(); const after=future.current.pop(); if (after && current.current) { past.current.push(current.current); current.current=after; render(after); } }
  return { value,set,reset,sync,begin,end,undo,redo,canUndo:past.current.length>0,canRedo:future.current.length>0 };
}
