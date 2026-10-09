import type { ReactNode } from 'react'
import type { Role } from '@/types'
import { IconCheck } from '@/lib/icons'
import { cn } from '@/lib/utils'

export function Pill({ children, tone = 'mine' }: { children: ReactNode, tone?: 'mine' | 'gray' | 'ok' | 'off' | 'warn' | 'violet' }) {
  return <span className={cn('lux-pill', tone != 'mine' && tone)}>{children}</span>
}

export function DotPill({ children, tone = 'ok' }: { children: ReactNode, tone?: 'ok' | 'off' | 'warn' }) {
  return <span className={cn('lux-pill', tone)}><i className="lux-dot" />{children}</span>
}

export function Field({
  label, name, type = 'text', autoComplete, required = false, placeholder, defaultValue, icon,
}: {
  label: string
  name: string
  type?: string
  autoComplete?: string
  required?: boolean
  placeholder?: string
  defaultValue?: string | number
  icon?: ReactNode
}) {
  return (
    <div className="lux-field">
      <label htmlFor={name}>{label}</label>
      <div className="lux-inp">
        {icon}
        <input id={name} name={name} type={type} autoComplete={autoComplete} required={required} placeholder={placeholder} defaultValue={defaultValue} />
      </div>
    </div>
  )
}

export function RoleSeg({ value, onChange }: { value: Role, onChange: (value: Role) => void }) {
  return (
    <div className="lux-field">
      <label>角色</label>
      <div className="lux-seg" role="group" aria-label="角色">
        <button type="button" className={value == 'user' ? 'on' : undefined} onClick={() => onChange('user')}>用户</button>
        <button type="button" className={value == 'admin' ? 'on' : undefined} onClick={() => onChange('admin')}>管理员</button>
      </div>
    </div>
  )
}

export function Cassette({ value, hint }: { value: string, hint?: string }) {
  return (
    <div className="lux-cassette mono">
      <span>{value}</span>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}

export function Toast({ message }: { message: string }) {
  if (!message) return null
  return (
    <div className="lux-toast" role="status" aria-live="polite">
      <span className="k"><IconCheck /></span>
      {message}
    </div>
  )
}

export function Avatar({ name, size = 36, tone = 'mine' }: { name: string, size?: number, tone?: 'mine' | 'well' }) {
  const initial = name.trim() ? name.trim()[0]!.toUpperCase() : '?'
  return (
    <div
      className="lux-av"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: tone == 'mine' ? 'var(--g-mine)' : 'var(--well)',
        boxShadow: size >= 52 ? 'var(--shadow-bubble)' : undefined,
      }}
    >
      {initial}
    </div>
  )
}

export function SourceTag({ source }: { source?: string }) {
  if (!source) return null
  const key = source.toLowerCase()
  const known = ['tx', 'wy', 'kg', 'kw', 'mg'].includes(key)
  return <i className={cn('lux-src', known && key)}>{source}</i>
}
