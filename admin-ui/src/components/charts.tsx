import type { ReactNode } from 'react'
import type { BarPoint, Slice } from '@/lib/charts'

export function ChartCard({ title, hint, children, compact }: { title: string, hint?: string, children: ReactNode, compact?: boolean }) {
  return (
    <div className={compact ? 'lux-chart-card lux-chart-card-flush' : 'lux-card lux-chart-card'}>
      <div className="lux-card-h">
        <div>
          <div className="lux-eyebrow">{title}</div>
          {hint ? <p>{hint}</p> : null}
        </div>
      </div>
      <div className="lux-chart-body">{children}</div>
    </div>
  )
}

/** App-style big number tiles — prefer over pie charts for counts. */
export function MetricTiles({ items }: { items: Array<{ label: string, value: string | number, hint?: string, tone?: 'lime' | 'nav' | 'admin' | 'status' | 'invites' | 'muted' }> }) {
  return (
    <div className="lux-metric-tiles">
      {items.map(item => (
        <div key={item.label} className={`lux-metric-tile tone-${item.tone || 'lime'}`}>
          <b>{item.value}</b>
          <span>{item.label}</span>
          {item.hint ? <small>{item.hint}</small> : null}
        </div>
      ))}
    </div>
  )
}

/** Single capsule progress (used / max). */
export function CapsuleProgress({
  label, used, max, suffix = '', tone = 'lime',
}: {
  label: string
  used: number
  max: number
  suffix?: string
  tone?: 'lime' | 'nav' | 'admin' | 'status' | 'invites' | 'warn'
}) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0
  return (
    <div className="lux-capsule">
      <div className="lux-capsule-meta">
        <span>{label}</span>
        <b>{used}{max > 0 ? ` / ${max}` : ''}{suffix}</b>
      </div>
      <div className={`lux-capsule-track tone-${tone}`} aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="lux-capsule-pct">{pct}%</div>
    </div>
  )
}

/** Stacked capsule segments for composition (roles, platforms, sources). */
export function SegmentBar({ slices, unit = '' }: { slices: Slice[], unit?: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  return (
    <div className="lux-segment">
      <div className="lux-segment-track" aria-hidden="true">
        {total ? slices.map(s => (
          <i key={s.key} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label} ${s.value}`} />
        )) : <i style={{ width: '100%', background: 'var(--divider)' }} />}
      </div>
      <ul className="lux-segment-legend">
        {slices.length ? slices.map(s => (
          <li key={s.key}>
            <i style={{ background: s.color }} />
            <span>{s.label}</span>
            <b>{s.value}{unit}</b>
          </li>
        )) : <li className="lux-note">暂无数据</li>}
      </ul>
    </div>
  )
}

/** Mini vertical columns — good for hour-of-day / discrete buckets. */
export function MiniColumns({ points, unit = '' }: { points: BarPoint[], unit?: string }) {
  const max = Math.max(1, ...points.map(p => p.value))
  return (
    <div className="lux-minicols">
      {points.length ? points.map(p => (
        <div key={p.key} className="lux-minicol">
          <span className="lux-minicol-val">{p.value}{unit}</span>
          <div className="lux-minicol-shaft" aria-hidden="true">
            <i style={{ height: `${(p.value / max) * 100}%` }} />
          </div>
          <span className="lux-minicol-label">{p.label}</span>
        </div>
      )) : <p className="lux-note">暂无数据</p>}
    </div>
  )
}

/** Compact horizontal capsule rows (playlist sources, etc.). */
export function CapsuleRows({ points, unit = '' }: { points: BarPoint[], unit?: string }) {
  const max = Math.max(1, ...points.map(p => p.value))
  return (
    <div className="lux-cap-rows">
      {points.length ? points.map(p => (
        <div key={p.key} className="lux-capsule">
          <div className="lux-capsule-meta">
            <span>{p.label}</span>
            <b>{p.value}{unit}</b>
          </div>
          <div className="lux-capsule-track tone-lime" aria-hidden="true">
            <i style={{ width: `${(p.value / max) * 100}%` }} />
          </div>
        </div>
      )) : <p className="lux-note">暂无数据</p>}
    </div>
  )
}

export function UsageCapsules({ items }: { items: Array<{ key: string, label: string, used: number, max: number, disabled?: boolean }> }) {
  return (
    <div className="lux-cap-rows">
      {items.length ? items.slice(0, 8).map(item => (
        <CapsuleProgress
          key={item.key}
          label={item.disabled ? `${item.label} · 已禁用` : item.label}
          used={item.used}
          max={item.max}
          suffix=" 次"
          tone={item.disabled ? 'warn' : item.used >= item.max && item.max > 0 ? 'invites' : 'lime'}
        />
      )) : <p className="lux-note">暂无邀请码</p>}
    </div>
  )
}
