import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getPref, setPref } from '@/lib/prefs'

export type ThemePref = 'system' | 'light' | 'dark'

const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export function applyTheme(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && media().matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

const Ctx = createContext<{ theme: ThemePref; setTheme: (t: ThemePref) => void } | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>(() => getPref<ThemePref>('theme', 'system'))
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const m = media()
    const on = () => applyTheme('system')
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [theme])
  const setTheme = (t: ThemePref) => {
    setPref('theme', t)
    setThemeState(t)
  }
  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>
}

export function useTheme() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}
