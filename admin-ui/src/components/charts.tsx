import type { ReactNode } from 'react'
import { donutGradient, type BarPoint, type Slice } from '@/lib/charts'

export function ChartCard({ title, hint, children }: { title: string, hint?: string, children: ReactNode }) {
  return (
    <div className="lux-card lux-chart-card">
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

export function DonutChart({ slices, center }: { slices: Slice[], center?: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  return (
    <div className="lux-donut-wrap">
      <div className="lux-donut" style={{ background: donutGradient(slices) }} aria-hidden="true">
        <div className="lux-donut-hole">
          <b>{total}</b>
          {center ? <span>{center}</span> : null}
        </div>
      </div>
      <ul className="lux-legend">
        {slices.length ? slices.map(s => (
          <li key={s.key}>
            <i style={{ background: s.color }} />
            <span>{s.label}</span>
            <b>{s.value}</b>
          </li>
        )) : <li className="lux-note">暂无数据</li>}
      </ul>
    </div>
  )
}

export function HBarChart({ points, unit = '' }: { points: BarPoint[], unit?: string }) {
  const max = Math.max(1, ...points.map(p => p.value))
  return (
    <div className="lux-hbar">
      {points.length ? points.map(p => (
        <div key={p.key} className="lux-hbar-row">
          <span className="lux-hbar-label">{p.label}</span>
          <div className="lux-hbar-track" aria-hidden="true">
            <i style={{ width: `${(p.value / max) * 100}%` }} />
          </div>
          <span className="lux-hbar-value">{p.value}{unit}</span>
        </div>
      )) : <p className="lux-note">暂无数据</p>}
    </div>
  )
}

export function UsageBars({ items }: { items: Array<{ key: string, label: string, used: number, max: number, disabled?: boolean }> }) {
  return (
    <div className="lux-usage">
      {items.length ? items.slice(0, 8).map(item => {
        const pct = item.max > 0 ? Math.min(100, Math.round((item.used / item.max) * 100)) : 0
        return (
          <div key={item.key} className="lux-usage-row">
            <div className="lux-usage-meta">
              <span className="mono">{item.label}</span>
              <span>{item.used}/{item.max}{item.disabled ? ' · 已禁用' : ''}</span>
            </div>
            <div className="lux-progress" style={{ width: '100%' }}><i style={{ width: `${pct}%` }} /></div>
          </div>
        )
      }) : <p className="lux-note">暂无邀请码</p>}
    </div>
  )
}

export function StatPair({ items }: { items: Array<{ label: string, value: string | number }> }) {
  return (
    <div className="lux-stat-pair">
      {items.map(item => (
        <div key={item.label}>
          <b>{item.value}</b>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  )
}
