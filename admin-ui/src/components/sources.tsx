import { useMemo, useRef, useState } from 'react'
import { adminApi } from '@/lib/api'
import { ChartCard, MetricTiles } from '@/components/charts'
import { DotPill, Field, Pill } from '@/components/primitives'
import { IconCircle, IconRefresh, IconScript, IconTrash } from '@/lib/icons'
import type { SourceScriptView, SourcesAdminResponse } from '@/types'

type UploadMode = 'paste' | 'file' | 'url'

const statusLabel = (script: SourceScriptView) => {
  switch (script.status) {
    case 'ready': return { tone: 'ok' as const, text: '就绪' }
    case 'initializing': return { tone: 'warn' as const, text: '初始化中' }
    case 'error': return { tone: 'off' as const, text: '错误' }
    default: return { tone: 'off' as const, text: '已禁用' }
  }
}

const readFileAsText = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(typeof reader.result == 'string' ? reader.result : '')
  reader.onerror = () => reject(new Error('无法读取文件'))
  reader.readAsText(file, 'utf-8')
})

function UploadPanel({ refresh, notify }: { refresh: () => Promise<void>, notify: (m: string) => void }) {
  const [mode, setMode] = useState<UploadMode>('paste')
  const [enableAfter, setEnableAfter] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pickedFile, setPickedFile] = useState<File | null>(null)

  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setUploadError(null)
    setBusy(true)
    const form = event.currentTarget
    try {
      let script: string | undefined
      let url: string | undefined
      if (mode == 'url') {
        url = (form.elements.namedItem('url') as HTMLInputElement).value.trim()
      } else if (mode == 'file') {
        const file = pickedFile ?? fileInputRef.current?.files?.[0]
        if (!file) throw new Error('请选择 .js 脚本文件')
        if (!file.name.toLowerCase().endsWith('.js')) throw new Error('仅支持 .js 文件')
        script = await readFileAsText(file)
      } else {
        script = (form.elements.namedItem('script') as HTMLTextAreaElement).value
        if (!script.trim()) throw new Error('请粘贴脚本内容')
      }

      const { script: entry } = await adminApi.uploadSource(url ? { url } : { script })
      form.reset()
      setPickedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''

      if (enableAfter) {
        const enabled = await adminApi.enableSource(entry.id)
        if (enabled.script.status == 'error' && enabled.script.error) {
          setUploadError(`脚本已保存，但启用失败：${enabled.script.error}`)
          notify('脚本已上传，启用失败')
        } else {
          notify(enabled.script.status == 'ready' ? '脚本已上传并启用' : '脚本已上传，正在初始化…')
        }
      } else {
        notify('脚本已上传（默认禁用，可在列表中启用）')
      }
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : '上传失败'
      setUploadError(message)
      notify(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lux-card lux-create-panel">
      <form className="lux-create-bar inv" onSubmit={submit}>
        <div className="title">
          <IconCircle tone="admin"><IconScript /></IconCircle>
          <div>
            <h3>上传音源脚本</h3>
            <p>LX 自定义源格式（/** @name … */ 头注释必填），默认上传后禁用</p>
          </div>
        </div>
        <div className="lux-seg" role="group" aria-label="上传方式">
          <button type="button" className={mode == 'paste' ? 'on' : undefined} onClick={() => setMode('paste')}>粘贴脚本</button>
          <button type="button" className={mode == 'file' ? 'on' : undefined} onClick={() => setMode('file')}>选择文件</button>
          <button type="button" className={mode == 'url' ? 'on' : undefined} onClick={() => setMode('url')}>URL 下载</button>
        </div>
        {mode == 'url'
          ? <Field label="脚本 URL" name="url" placeholder="https://..." required />
          : mode == 'file'
            ? (
              <div className="lux-field">
                <label htmlFor="script-file">脚本文件 (.js)</label>
                <input
                  id="script-file"
                  ref={fileInputRef}
                  name="scriptFile"
                  type="file"
                  accept=".js,text/javascript,application/javascript"
                  required
                  onChange={e => setPickedFile(e.target.files?.[0] ?? null)}
                  style={{ width: '100%' }}
                />
                {pickedFile ? <p className="lux-note" style={{ marginTop: 6 }}>{pickedFile.name} · {(pickedFile.size / 1024).toFixed(1)} KB</p> : null}
              </div>
            )
            : (
              <div className="lux-field">
                <label htmlFor="script">脚本内容</label>
                <textarea
                  id="script"
                  name="script"
                  required
                  rows={8}
                  style={{ width: '100%', borderRadius: 12, padding: 12, border: '1px solid var(--line)', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                  placeholder={'/**\n * @name 我的源\n * @version 1\n */'}
                />
              </div>
            )}
        <label className="lux-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={enableAfter} onChange={e => setEnableAfter(e.target.checked)} />
          上传后立即启用（若沙箱初始化失败，错误会显示在下方与脚本列表中）
        </label>
        {uploadError ? (
          <p className="lux-note" role="alert" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{uploadError}</p>
        ) : null}
        <button type="submit" className="lux-btn primary" style={{ height: 40, padding: '0 18px' }} disabled={busy}>
          {busy ? '上传中…' : '上传'}
        </button>
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
      else {
        const res = await adminApi.enableSource(script.id)
        if (res.script.status == 'error' && res.script.error) {
          notify(`启用失败：${res.script.error}`)
        } else {
          notify(script.enabled ? '已禁用' : '已启用')
        }
      }
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
