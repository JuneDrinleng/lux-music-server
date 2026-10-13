import { useMemo, useState } from 'react'
import { adminApi } from '@/lib/api'
import { ChartCard, MetricTiles } from '@/components/charts'
import { DotPill, Field, Pill } from '@/components/primitives'
import { IconCircle, IconRefresh, IconScript, IconTrash } from '@/lib/icons'
import type { SourceScriptView, SourcesAdminResponse } from '@/types'

const statusLabel = (script: SourceScriptView) => {
  switch (script.status) {
    case 'ready': return { tone: 'ok' as const, text: '就绪' }
    case 'initializing': return { tone: 'warn' as const, text: '初始化中' }
    case 'error': return { tone: 'off' as const, text: '错误' }
    default: return { tone: 'off' as const, text: '已禁用' }
  }
}

function UploadPanel({ refresh, notify }: { refresh: () => Promise<void>, notify: (m: string) => void }) {
  const [urlMode, setUrlMode] = useState(false)
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const script = (form.elements.namedItem('script') as HTMLTextAreaElement).value.trim()
    const url = (form.elements.namedItem('url') as HTMLInputElement).value.trim()
    try {
      await adminApi.uploadSource(urlMode ? { url } : { script })
      form.reset()
      notify('脚本已上传')
      await refresh()
    } catch (err) {
      notify(err instanceof Error ? err.message : '上传失败')
    }
  }
  return (
    <div className="lux-card lux-create-panel">
      <form className="lux-create-bar inv" onSubmit={submit}>
        <div className="title">
          <IconCircle tone="admin"><IconScript /></IconCircle>
          <div>
            <h3>上传音源脚本</h3>
            <p>LX 自定义源格式，默认上传后禁用</p>
          </div>
        </div>
        <div className="lux-seg" role="group" aria-label="上传方式">
          <button type="button" className={!urlMode ? 'on' : undefined} onClick={() => setUrlMode(false)}>粘贴脚本</button>
          <button type="button" className={urlMode ? 'on' : undefined} onClick={() => setUrlMode(true)}>URL 下载</button>
        </div>
        {urlMode
          ? <Field label="脚本 URL" name="url" placeholder="https://..." required />
          : (
            <div className="lux-field">
              <label htmlFor="script">脚本内容</label>
              <textarea id="script" name="script" required rows={6} style={{ width: '100%', borderRadius: 12, padding: 12, border: '1px solid var(--line)', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder="/** @name ... */" />
            </div>
          )}
        <button type="submit" className="lux-btn primary" style={{ height: 40, padding: '0 18px' }}>上传</button>
      </form>
    </div>
  )
}

function ScriptRow({
  script, refresh, notify,
}: { script: SourceScriptView, refresh: () => Promise<void>, notify: (m: string) => void }) {
  const st = statusLabel(script)
  const toggle = async() => {
    try {
      if (script.enabled) await adminApi.disableSource(script.id)
      else await adminApi.enableSource(script.id)
      notify(script.enabled ? '已禁用' : '已启用')
      await refresh()
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败')
    }
  }
  const remove = async() => {
    try {
      await adminApi.deleteSource(script.id)
      notify('脚本已删除')
      await refresh()
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败')
    }
  }
  const sources = Object.keys(script.sources).join(', ') || '—'
  return (
    <div className="lux-row" style={{ minHeight: 64 }}>
      <IconCircle tone="admin"><IconScript /></IconCircle>
      <div className="t">
        <b>{script.name}</b>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
          <Pill tone="gray">#{script.priority}</Pill>
          <DotPill tone={st.tone}>{st.text}</DotPill>
          <span className="lux-note mono">{script.id}</span>
        </div>
        {script.error ? <p className="lux-note" style={{ color: 'var(--danger)', marginTop: 6 }}>{script.error}</p> : null}
        <p className="lux-note" style={{ marginTop: 4 }}>源：{sources}</p>
      </div>
      <div className="acts">
        <button type="button" className={script.enabled ? 'lux-btn sm ghost' : 'lux-btn sm primary'} onClick={() => void toggle()}>
          {script.enabled ? '禁用' : '启用'}
        </button>
        <button type="button" className="lux-iconbtn del" onClick={() => void remove()} title="删除"><IconTrash /></button>
      </div>
    </div>
  )
}

export function SourcesSection({
  data, refresh, notify,
}: {
  data: SourcesAdminResponse | null
  refresh: () => Promise<void>
  notify: (m: string) => void
}) {
  const scripts = data?.scripts ?? []
  const info = data?.info
  const settings = data?.settings
  const metrics = useMemo(() => ([
    { label: '可用', value: info?.available ? '是' : '否', tone: 'status' as const, hint: '解析' },
    { label: '脚本', value: scripts.length, tone: 'nav' as const, hint: '个' },
    { label: '就绪', value: scripts.filter(s => s.status == 'ready').length, tone: 'lime' as const, hint: 'worker' },
    { label: '代理', value: settings?.proxyStream ? '开' : '关', tone: 'invites' as const, hint: '流' },
  ]), [info, scripts, settings])

  return (
    <div className="lux-stack">
      <UploadPanel refresh={refresh} notify={notify} />
      <div className="lux-page-split invites">
        <div className="lux-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="lux-card-h">
            <div>
              <h3>音源脚本</h3>
              <p>启用后在 worker 沙箱中运行；优先级数字越小越先尝试</p>
            </div>
            <button type="button" className="lux-btn sm ghost" onClick={() => void refresh()}><IconRefresh />刷新</button>
          </div>
          <div className="lux-rows" style={{ flex: 1 }}>
            {!scripts.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无脚本</p> : scripts.map(script => (
              <ScriptRow key={script.id} script={script} refresh={refresh} notify={notify} />
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <ChartCard title="运行设置" hint="来自环境变量">
            <MetricTiles items={metrics} />
            {settings ? (
              <p className="lux-note" style={{ marginTop: 12 }}>
                超时 {settings.timeoutMs} ms · 内存 {settings.memoryMb} MB · 流代理 {settings.proxyStream ? '开启' : '关闭'}
              </p>
            ) : null}
          </ChartCard>
          {info ? (
            <ChartCard title="已声明能力" hint="所有就绪脚本取并集">
              <div className="lux-rows">
                {Object.entries(info.sources).map(([source, cap]) => (
                  <div key={source} className="lux-row" style={{ minHeight: 48 }}>
                    <Pill tone="mine">{source}</Pill>
                    <span className="lux-note">{cap?.actions.join(', ')} · {cap?.qualitys.join(', ')}</span>
                  </div>
                ))}
                {!Object.keys(info.sources).length ? <p className="lux-note">暂无在线源能力</p> : null}
              </div>
            </ChartCard>
          ) : null}
        </div>
      </div>
    </div>
  )
}
