import { useEffect, useState } from 'react';
export type BackgroundTheme = 'simple' | 'glass';
const key = 'tg-vault.background';
const eventName = 'tgvault:background-change';
let memory: BackgroundTheme | undefined;
function read(): BackgroundTheme {
    if (memory) return memory;
    try {
        return localStorage.getItem(key) === 'glass' ? 'glass' : 'simple';
    } catch { return 'simple'; }
}
function apply(value: BackgroundTheme) { document.documentElement.dataset.background = value; }
export function initializeBackground() { apply(read()); }
export function useBackground() {
    const [background, setValue] = useState<BackgroundTheme>(read);
    useEffect(() => {
        apply(read());
        const sync = () => { const next = read(); apply(next); setValue(next); };
        const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) { memory = undefined; sync(); } };
        window.addEventListener(eventName, sync);
        window.addEventListener('storage', storage);
        return () => { window.removeEventListener(eventName, sync); window.removeEventListener('storage', storage); };
    }, []);
    const setBackground = (next: BackgroundTheme) => {
        if (next !== 'simple' && next !== 'glass') return;
        memory = next;
        try { localStorage.setItem(key, next); } catch { /* Retain choice for this session. */ }
        apply(next); setValue(next); window.dispatchEvent(new Event(eventName));
    };
    return { background, setBackground };
}
