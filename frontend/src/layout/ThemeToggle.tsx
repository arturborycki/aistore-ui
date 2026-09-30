import { Monitor, Moon, Sun } from 'lucide-react'
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/dropdown'
import { Tooltip } from '@/components/ui/tooltip'
import { useTheme, type ThemePref } from './theme'

const icons = { light: Sun, dark: Moon, system: Monitor }

/** Light / dark / system theme switch (also in the account menu). */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const Icon = icons[theme]
  return (
    <Menu>
      <Tooltip content="Theme">
        <MenuTrigger asChild>
          <button type="button" aria-label={`Theme: ${theme}`} className="rounded p-1.5 text-muted hover:bg-surface hover:text-fg">
            <Icon className="size-4" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end">
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
          <MenuRadioItem value="light" icon={<Sun />}>Light</MenuRadioItem>
          <MenuRadioItem value="dark" icon={<Moon />}>Dark</MenuRadioItem>
          <MenuRadioItem value="system" icon={<Monitor />}>System</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  )
}
