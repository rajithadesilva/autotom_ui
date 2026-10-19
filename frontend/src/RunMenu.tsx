import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import type { Run } from './types';

export default function RunMenu({ run, busy, onRename, onDelete }: {
  run: Run; busy: boolean; onRename: (run: Run) => void; onDelete: (run: Run) => void;
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const active = run.status === 'queued' || run.status === 'running';
  const close = () => { setPosition(null); trigger.current?.focus(); };

  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const dismiss = () => setPosition(null);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [position]);

  return <>
    <button ref={trigger} className="run-menu-trigger" aria-label={`Actions for ${run.name}`} title="Run actions" aria-haspopup="menu" aria-expanded={Boolean(position)} disabled={busy}
      onClick={() => {
        if (position) { setPosition(null); return; }
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.right - 160, window.innerWidth - 168)), top: rect.bottom + 92 < window.innerHeight ? rect.bottom + 4 : rect.top - 88 });
      }}><Ellipsis size={17} /></button>
    {position && createPortal(<div ref={menu} className="run-actions-menu" role="menu" aria-label={`Actions for ${run.name}`} style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      <button role="menuitem" disabled={busy} onClick={() => { close(); onRename(run); }}><Pencil size={13} />Rename</button>
      <button role="menuitem" className="danger" disabled={busy || active} title={active ? 'Cancel the run and wait for it to stop before deleting' : 'Delete run and all results'} onClick={() => { close(); onDelete(run); }}><Trash2 size={13} />Delete</button>
    </div>, document.body)}
  </>;
}
