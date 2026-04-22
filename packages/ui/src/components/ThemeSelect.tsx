import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { isThemeMode, type ThemeMode, useThemeMode } from '#/lib/theme'

const themeOptions: Array<{
  label: string
  value: ThemeMode
  description: string
}> = [
  {
    label: 'System',
    value: 'auto',
    description: 'Follow the operating system preference.',
  },
  {
    label: 'Light',
    value: 'light',
    description: 'Use the light dashboard theme.',
  },
  {
    label: 'Dark',
    value: 'dark',
    description: 'Use the dark dashboard theme.',
  },
]

export function ThemeSelect() {
  const [mode, setMode] = useThemeMode()

  return (
    <Select<ThemeMode>
      items={themeOptions}
      value={mode}
      onValueChange={(value) => {
        if (isThemeMode(value)) {
          setMode(value)
        }
      }}
    >
      <SelectTrigger
        className="w-full max-w-xs bg-background"
        aria-label="Theme"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {themeOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="flex flex-col">
                <span>{option.label}</span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
